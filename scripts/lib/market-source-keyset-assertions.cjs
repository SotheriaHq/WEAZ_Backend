const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {pipelineSourcePageSql}=require('../../src/market/pipeline/market-pipeline.section-reader');
const {readPipelineEpochContext}=require('../../src/market/pipeline/market-pipeline.database');
const {MARKET_FEATURE_PARAMETERS,MARKET_FEATURE_STATE_KEY}=require('../../src/market/intelligence/market-intelligence.contracts');

async function runMarketSourceKeysetAssertions({db,prisma,now,brand,owner,chosen,firstFile,queryStats,config}){
  assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(db.connectionParameters.database));
  let checks=0;
  const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
  const products=Array.from({length:70},(_,position)=>({id:randomUUID(),brandId:brand.id,name:'Beyond preview '+position,price:9000,totalStock:1,standardCheckoutEnabled:true,isActive:true,publicationStatus:'PUBLISHED',thumbnail:firstFile.s3Url,images:[firstFile.s3Url],firstPublishedAt:new Date(now.getTime()-1000)}));
  await prisma.product.createMany({data:products});
  // Product sources only serve cards with an approved, renderable cover, so
  // the paging fixture needs its media before the first seek.
  await prisma.productMedia.createMany({data:products.map(product=>({productId:product.id,fileUploadId:firstFile.id,brandId:brand.id,createdById:owner.id,viewSlot:'FRONT',reviewStatus:'APPROVED'}))});
  const productIds=[chosen.id,...products.map(product=>product.id)];
  await prisma.featuredItem.createMany({data:productIds.map((entityId,position)=>({id:randomUUID(),entityType:'PRODUCT',entityId,brandId:brand.id,placementKey:'SCOPE_LONG',position,startsAt:now,expiresAt:new Date(now.getTime()+60000),isActive:true,featuredById:owner.id}))});
  const designs=Array.from({length:70},(_,position)=>({id:randomUUID(),ownerId:owner.id,title:'Beyond design preview '+position,domain:'DESIGN',status:'PUBLISHED',visibility:'PUBLIC',createdAt:new Date(now.getTime()-1000)}));
  await prisma.collection.createMany({data:designs});
  await prisma.collectionMedia.createMany({data:designs.map(design=>({id:randomUUID(),collectionId:design.id,fileUploadId:firstFile.id,mediaType:'POST_IMAGE',viewSlot:'FRONT',reviewStatus:'APPROVED'}))});
  const request=source=>({sectionKey:'complete-source-proof',source,filters:{},fixedFilterLayers:[{brandIds:[brand.id]}],asOf:now,epoch:null,limit:1,signal:new AbortController().signal,suppressionMode:'viewer'});
  const cases=[
    [{kind:'curated',placementKey:'SCOPE_LONG'},productIds],
    [{kind:'from_runway'},designs.map(design=>design.id).sort().reverse()],
  ];
  for(const[source,expected]of cases){
    const selected=request(source),ids=[];
    let after,revision,done=false;
    for(let page=0;page<15;page++){
      const result=await prisma.$queryRaw(pipelineSourcePageSql({request:selected,viewer:{},limit:7,...(after?{after,revision}:{})}));
      assert(result.length===1,'Each source page has a single bounded envelope');
      const current=result[0];
      assert(current.rows.length<=7,'Full-set source transfer stays at the requested page bound');
      equal(current.reanchored,false,source.kind+' stable source does not restart during seek');
      if(revision!==undefined)equal(current.revision,revision,source.kind+' stable source keeps its revision');
      revision=current.revision;ids.push(...current.rows.map(row=>row.id));
      if(current.rows.length<7){done=true;break;}
      after=current.rows[current.rows.length-1].orderKey;
    }
    equal(done,true,source.kind+' seek reaches the true end of the complete source');
    equal(ids,expected,source.kind+' pages beyond the 61-item preview prefix in exact source order');
    equal(new Set(ids).size,ids.length,source.kind+' keysets never repeat a product or design');
    assert(ids.length>61,'Fixture must actually cross the preview boundary');
    checks++;
  }
  const clock=(await prisma.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp()) AS "asOf"`)[0].asOf;
  const epochStart=new Date(Math.floor(clock.getTime()/21600000)*21600000);
  const manifest=await prisma.marketFeatureEpoch.create({data:{id:randomUUID(),stateKey:MARKET_FEATURE_STATE_KEY,generation:2n,status:'READY',epochStart,epochEnd:new Date(epochStart.getTime()+21600000),sourceAsOf:clock,readyAt:clock,acceptUntil:new Date(clock.getTime()+21600000),cleanupAfter:new Date(clock.getTime()+86400000),parameters:{...MARKET_FEATURE_PARAMETERS}}});
  const metric={completeness:'COMPLETE',requiredWindowStart:new Date(clock.getTime()-28*86400000).toISOString(),requiredWindowEnd:clock.toISOString()};
  for(const product of products.slice(0,3))await prisma.marketItemFeatureSnapshot.create({data:{epochId:manifest.id,productId:product.id,sourceComputedAt:clock,sourceAsOf:clock,purchasable:true,decayedPopularity:1,qualityScore:2,trendEligible:true,trendScore:3,actors7d:8,coverage:{decayedPopularity:metric,qualityScore:metric,trendScore:metric,actors7d:{...metric,requiredWindowStart:new Date(clock.getTime()-7*86400000).toISOString()}}}});
  await prisma.marketFeatureState.update({where:{key:MARKET_FEATURE_STATE_KEY},data:{generation:2n,currentEpochId:manifest.id}});
  const epochRead=(filters={brandIds:[brand.id]})=>prisma.$transaction(async tx=>{await tx.$executeRaw`SET TRANSACTION READ ONLY`;return readPipelineEpochContext(tx,{filters,viewer:{}});},{isolationLevel:'RepeatableRead',timeout:5000});
  const current=await epochRead();
  equal(current.eligibleProductCount,8,'Real epoch/probe SQL caps the complete eligible catalogue probe at eight');
  equal(current.epoch.id,manifest.id,'Real epoch loader resolves the current READY manifest');
  equal(current.epoch.intentProductCount,3,'Market-wide evidence counts currently eligible feature rows');
  const filtered=await epochRead({brandIds:[randomUUID()]});
  equal(filtered.eligibleProductCount,0,'Empty user filters retain a genuine zero catalogue size');
  equal(filtered.epoch.intentProductCount,3,'User filters do not lower the Market-wide evidence floor');
  await prisma.product.update({where:{id:products[0].id},data:{publicationStatus:'DRAFT'}});
  equal((await epochRead()).epoch.intentProductCount,2,'A newly drafted product is excluded from the live evidence floor');
  await prisma.product.update({where:{id:products[0].id},data:{publicationStatus:'PUBLISHED'}});
  // Exercise the real two-phase public read and report every physical Prisma
  // query event. Transaction controls are reported separately, never hidden.
  const {createMarketCatalogScope,marketCatalogScopeSql}=require('../../src/market/catalog/market-catalog-scope');
  const {Prisma}=require('@prisma/client');
  const trendScope=floor=>createMarketCatalogScope({key:'custom-trend-proof',version:'1',viewer:{},trendEvidence:{epochId:manifest.id,actorFloor:floor}});
  const eligibleTrend=async floor=>(await prisma.$queryRaw(Prisma.sql`SELECT p."_id" AS id FROM "Product" p WHERE ${marketCatalogScopeSql(trendScope(floor),'p',clock)}`)).length;
  equal(await eligibleTrend(8),3,'Custom trend scope admits exactly the frozen qualified actors');
  equal(await eligibleTrend(9),0,'Raising a custom actor floor cannot widen See All or facet membership');
  await prisma.featuredItem.createMany({data:products.slice(0,61).map((product,position)=>({id:randomUUID(),entityType:'PRODUCT',entityId:product.id,brandId:brand.id,placementKey:'SCOPE_PERF',position,startsAt:clock,expiresAt:new Date(clock.getTime()+60000),isActive:true,featuredById:owner.id}))});
  const {MarketCatalogReadService}=require('../../src/market/catalog/market-catalog-read.service');
  const {MarketPublicMediaService}=require('../../src/market/catalog/market-public-media.service');
  const {MarketPipelineMediaResolver}=require('../../src/market/pipeline/market-pipeline.media');
  const {buildMarketPipelinePage}=require('../../src/market/pipeline/market-pipeline.page');
  const {parsePipelineSpec}=require('../../src/market/pipeline/market-pipeline.schema');
  const read=new MarketCatalogReadService(prisma);
  const {MarketCatalogService}=require('../../src/market/catalog/market-catalog.service');
  const scopedCatalogue=new MarketCatalogService(read,new MarketPublicMediaService(read,config),config);
  console.log('STAGE ordered custom trend first page');
  const firstTrend=await scopedCatalogue.getPage(new URLSearchParams('sort=newest&limit=1'),{},{scope:trendScope(8),fixedFilters:{}});
  equal(firstTrend.items.length,1,'An ordered custom-trend page retains evidence qualification');
  assert(firstTrend.pagination.nextCursor,'Qualified trend fixture must have a second page');
  console.log('STAGE ordered custom trend continuation');
  const secondTrend=await scopedCatalogue.getPage(new URLSearchParams('sort=newest&limit=1&cursor='+encodeURIComponent(firstTrend.pagination.nextCursor)),{},{scope:trendScope(8),fixedFilters:{}});
  equal(secondTrend.items.length,1,'An ordered trend cursor can restore its pinned immutable evidence');
  equal(secondTrend.items[0].id===firstTrend.items[0].id,false,'Pinned evidence continuation retains source keyset order');
  // Every statement the driver sends is counted, including BEGIN/COMMIT/SET.
  // An N+1 read makes the count grow with the number of cards or rows served,
  // so the same request at two result sizes must issue identical counts.
  const measure=async work=>{
    const before=queryStats(),started=performance.now();
    const result=await work();
    const after=queryStats();
    const total=after.total-before.total,controls=after.controls-before.controls;
    return{result,total,controls,data:total-controls,elapsedMs:Math.round(performance.now()-started),statements:after.statementsSince?.(before.total)??[]};
  };
  console.log('STAGE full pipeline query budget and N+1 invariance');
  const shelf=preview=>buildMarketPipelinePage({read,media:new MarketPipelineMediaResolver(new MarketPublicMediaService(read,config)),viewer:{},surface:'HOME',filters:{},specs:[parsePipelineSpec({key:'bounded-read-proof',template:'CURATED_LIST',status:'ACTIVE',curated:{placementKey:'SCOPE_PERF'},capacity:{preview,minItems:1},params:{maxPerBrand:8,maxPerCategory:8,explorationShare:0}})]});
  const oneCard=await measure(()=>shelf(1));
  const fullShelf=await measure(()=>shelf(8));
  equal(oneCard.result.public.sections[0]?.items.length,1,'A one-card shelf renders one card');
  equal(fullShelf.result.public.sections[0]?.items.length,8,'Real public capture and media authorization render the requested shelf');
  equal(fullShelf.total,oneCard.total,'N+1: Market page statements do not grow from 1 to 8 cards');
  console.log('QUERY_BUDGET '+JSON.stringify({page:{oneCard:oneCard.total,eightCards:fullShelf.total,controls:fullShelf.controls,data:fullShelf.data,limit:12,elapsedMs:fullShelf.elapsedMs}}));
  if(fullShelf.total>12)fullShelf.statements.forEach((head,index)=>console.log('QUERY_BUDGET_STATEMENT '+(index+1)+' '+head));
  assert(fullShelf.total<=12,'Market page stays within its 12-statement budget, got '+fullShelf.total);checks++;
  const cataloguePage=limit=>scopedCatalogue.getPage(new URLSearchParams('sort=newest&limit='+limit),{},{scope:createMarketCatalogScope({key:'catalog',version:'1',viewer:{}}),fixedFilters:{}});
  const catalogueOne=await measure(()=>cataloguePage(1));
  const catalogueMany=await measure(()=>cataloguePage(24));
  equal(catalogueOne.result.items.length,1,'A one-item catalogue page renders one item');
  assert(catalogueMany.result.items.length>=12,'A larger catalogue page renders many items');checks++;
  equal(catalogueMany.total,catalogueOne.total,'N+1: catalogue page statements do not grow with page size');
  console.log('QUERY_BUDGET '+JSON.stringify({catalogue:{oneItem:catalogueOne.total,manyItems:catalogueMany.total,itemsServed:catalogueMany.result.items.length,controls:catalogueMany.controls,elapsedMs:catalogueMany.elapsedMs}}));
  console.log(`PASS ${checks} complete product/nonproduct source-keyset proofs beyond preview capacity`);
  return{checks};
}
module.exports={runMarketSourceKeysetAssertions};
