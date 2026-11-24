const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {pipelineBatchSourcesSql}=require('../../src/market/pipeline/market-pipeline.database.sql');
const {pipelineRequestKey,captureMarketPipelinePage}=require('../../src/market/pipeline/market-pipeline.database');
const {parsePipelineSpec}=require('../../src/market/pipeline/market-pipeline.schema');
const {MARKET_FEATURE_PARAMETERS,MARKET_FEATURE_STATE_KEY}=require('../../src/market/intelligence/market-intelligence.contracts');
const {runPipelineTransitions}=require('./market-pipeline-fixture-transitions.cjs');
const {runMarketCatalogSourceScopeAssertions}=require('./market-catalog-source-scope-assertions.cjs');

async function runPipelineFixture({db,prisma,now,queryCount,queryStats}) {
  assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(db.connectionParameters.database));
  let checks=0,plans=0;
  const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;if(checks%25===0)console.log(`PROGRESS ${checks} actual PostgreSQL proofs passed`);};
  const user=await prisma.user.create({data:{id:randomUUID(),username:'fixture-owner',email:'owner@fixture.invalid',status:'ACTIVE'}});
  const viewer=await prisma.user.create({data:{id:randomUUID(),username:'fixture-viewer',email:'viewer@fixture.invalid',status:'ACTIVE'}});
  await prisma.userProfile.create({data:{userId:user.id,firstName:'PRIVATE PROFILE SENTINEL',lastName:'PRIVATE FAMILY SENTINEL',phoneNumber:'PRIVATE PHONE SENTINEL',address:'PRIVATE ADDRESS SENTINEL'}});
  const brand=await prisma.brand.create({data:{id:randomUUID(),ownerId:user.id,name:'Public brand',isStoreOpen:true,logo:'https://media.fixture.invalid/logo',createdAt:now}});
  const category=await prisma.collectionCategory.create({data:{id:randomUUID(),slug:'gowns',name:'Gowns'}});
  const categoryB=await prisma.collectionCategory.create({data:{id:randomUUID(),slug:'wraps',name:'Wraps'}});
  const garment=await prisma.collectionCategoryType.create({data:{id:randomUUID(),categoryId:category.id,slug:'dress',name:'Dress'}});
  const makeFile=async()=>{const id=randomUUID();return prisma.fileUpload.create({data:{id,userId:user.id,originalName:'Image',fileName:'image.webp',s3Key:'fixture/'+id+'.webp',s3Url:'https://private.fixture.invalid/'+id+'.webp',fileType:'POST_IMAGE',mimeType:'image/webp',size:100,processingStatus:'READY',assetVersion:1}});};
  const addProduct=async(extra={})=>{
    const file=await makeFile();
    const p=await prisma.product.create({data:{id:randomUUID(),brandId:brand.id,name:'Public piece',price:10000,isActive:true,publicationStatus:'PUBLISHED',firstPublishedAt:now,
      thumbnail:file.s3Url,images:[file.s3Url],categoryId:category.id,categoryTypeId:garment.id,totalStock:2,trackInventory:true,standardCheckoutEnabled:true,colors:['Red'],sizes:['M'],sizeStock:{M:2},...extra}});
    await prisma.productMedia.create({data:{productId:p.id,fileUploadId:file.id,brandId:brand.id,createdById:user.id,viewSlot:'FRONT',reviewStatus:'APPROVED'}});
    return {p,file};
  };
  const a=await addProduct(), b=await addProduct({price:12000}), c=await addProduct({categoryId:categoryB.id,categoryTypeId:null,customOrderEnabled:true,totalStock:0}),
    expensive=await addProduct({price:1000000,categoryId:categoryB.id,categoryTypeId:null}), draft=await addProduct({publicationStatus:'DRAFT'});
  await prisma.productVariant.createMany({data:[{id:randomUUID(),productId:b.p.id,color:'Red',size:'L',stock:2},{id:randomUUID(),productId:b.p.id,color:'Blue',size:'M',stock:2}]});
  const publicLook=await prisma.storeCollection.create({data:{id:randomUUID(),ownerId:user.id,title:'Public look',status:'PUBLISHED',visibility:'PUBLIC',isAvailableInStore:true}});
  const badLook=await prisma.storeCollection.create({data:{id:randomUUID(),ownerId:user.id,title:'Insufficient ratio',status:'PUBLISHED',visibility:'PUBLIC',isAvailableInStore:true}});
  const privateLook=await prisma.storeCollection.create({data:{id:randomUUID(),ownerId:user.id,title:'PRIVATE SENTINEL',description:'PRIVATE DESCRIPTION',status:'PUBLISHED',visibility:'PRIVATE',isAvailableInStore:true}});
  await prisma.storeCollectionProduct.createMany({data:[a,b,c].map(({p})=>({id:randomUUID(),collectionId:publicLook.id,productId:p.id})).concat([a,b,draft].map(({p})=>({id:randomUUID(),collectionId:badLook.id,productId:p.id})),[a,b,c].map(({p})=>({id:randomUUID(),collectionId:privateLook.id,productId:p.id})))});
  const design=await prisma.collection.create({data:{id:randomUUID(),ownerId:user.id,title:'Public design',domain:'DESIGN',status:'PUBLISHED',visibility:'PUBLIC',categoryId:category.id}});
  const designFile=await makeFile();
  await prisma.collectionMedia.create({data:{id:randomUUID(),collectionId:design.id,fileUploadId:designFile.id,mediaType:'POST_IMAGE',viewSlot:'FRONT',reviewStatus:'APPROVED'}});
  const secretDesign=await prisma.collection.create({data:{id:randomUUID(),ownerId:user.id,title:'PRIVATE DESIGN SENTINEL',domain:'DESIGN',status:'PUBLISHED',visibility:'PRIVATE'}});
  const secretFile=await makeFile();
  await prisma.collectionMedia.create({data:{id:randomUUID(),collectionId:secretDesign.id,fileUploadId:secretFile.id,mediaType:'POST_IMAGE',viewSlot:'FRONT',reviewStatus:'APPROVED'}});
  const featured=await prisma.featuredItem.create({data:{id:randomUUID(),entityType:'PRODUCT',entityId:a.p.id,brandId:brand.id,placementKey:'FIXTURE',position:0,startsAt:now,expiresAt:new Date(now.getTime()+1),isActive:true,featuredById:user.id}});
  await prisma.productComplement.create({data:{productId:a.p.id,complementId:c.p.id,status:'APPROVED'}});
  const tag=await prisma.tag.create({data:{id:randomUUID(),normalizedName:'fixture-tag',displayName:'Fixture tag',status:'APPROVED',createdById:user.id}});
  await prisma.tagBinding.createMany({data:[a,b].map(({p})=>({id:randomUUID(),tagId:tag.id,entityType:'PRODUCT',entityId:p.id}))});
  const dimension=await prisma.filterDimension.create({data:{id:randomUUID(),slug:'fabric',name:'Fabric',appliesTo:['PRODUCT','COLLECTION']}});
  const cotton=await prisma.filterValue.create({data:{id:randomUUID(),dimensionId:dimension.id,slug:'cotton',name:'Cotton'}});
  await prisma.entityFilter.create({data:{id:randomUUID(),filterValueId:cotton.id,entityType:'PRODUCT',entityId:a.p.id,productId:a.p.id}});
  await prisma.marketFeatureState.create({data:{key:MARKET_FEATURE_STATE_KEY,parameters:{...MARKET_FEATURE_PARAMETERS},generation:1n}});
  const manifest=await prisma.marketFeatureEpoch.create({data:{id:randomUUID(),stateKey:MARKET_FEATURE_STATE_KEY,generation:1n,status:'READY',epochStart:new Date(now.getTime()-3600000),epochEnd:new Date(now.getTime()+3600000),sourceAsOf:now,readyAt:now,acceptUntil:new Date(now.getTime()+7200000),cleanupAfter:new Date(now.getTime()+86400000),parameters:{...MARKET_FEATURE_PARAMETERS}}});
  const metric={completeness:'COMPLETE',requiredWindowStart:new Date(now.getTime()-28*86400000).toISOString(),requiredWindowEnd:now.toISOString()};
  for(const {p} of [a,b,c,expensive])await prisma.marketItemFeatureSnapshot.create({data:{epochId:manifest.id,productId:p.id,sourceComputedAt:now,sourceAsOf:now,purchasable:true,decayedPopularity:p.id===a.p.id?10:1,trendEligible:true,trendScore:3,qualityScore:2,actors7d:8,coverage:{decayedPopularity:metric,trendScore:metric,qualityScore:metric,actors7d:{...metric,requiredWindowStart:new Date(now.getTime()-7*86400000).toISOString()}}}});
  const epoch={id:manifest.id,epochStart:manifest.epochStart.toISOString(),epochEnd:manifest.epochEnd.toISOString(),sourceAsOf:now.toISOString(),acceptUntil:manifest.acceptUntil.toISOString(),stateKey:MARKET_FEATURE_STATE_KEY,status:'READY',featureSchemaVersion:1,policyVersion:1,complete:{popularity:true,trend:true,quality:true},intentProductCount:4};
  const request=(source,extra={})=>({sectionKey:'fixture',source,filters:{},fixedFilterLayers:[{}],asOf:now,epoch,limit:300,signal:new AbortController().signal,suppressionMode:'viewer',...extra});
  const read=async(source,extra={},identity={})=>{
    const input=request(source,extra),sql=pipelineBatchSourcesSql([{key:pipelineRequestKey(input),request:input}],identity);
    let result;
    try { result={rows:await prisma.$queryRaw(sql)}; }
    catch(error){ console.error(`QUERY FAILED ${source.kind}:${source.sort||''} code=${error.code||error.name} position=${error.position||'unknown'}`);throw error; }
    assert(result.rows.length<=Math.min(input.limit,61),'Actual source transfer bound');
    return result.rows;
  };
  const sources=[{kind:'catalog',sort:'newest',firstPublishedAfter:null},{kind:'catalog',sort:'popular',firstPublishedAfter:null},{kind:'catalog',sort:'trending',firstPublishedAfter:null},
    {kind:'low_stock',threshold:3},{kind:'curated',placementKey:'FIXTURE'},{kind:'similar',productId:a.p.id},{kind:'complements',productId:a.p.id},
    {kind:'from_runway'},{kind:'looks',minEligibleProducts:2,minEligibleRatio:0.7},{kind:'new_designers',maxAgeDays:180,minEligibleProducts:3},{kind:'category_tiles',minEligibleProducts:2}];
  for(const source of sources){const result=await read(source);assert(result.length>0,'Actual source '+source.kind+' should contain fixture rows');checks++;
    const input=request(source),sql=pipelineBatchSourcesSql([{key:pipelineRequestKey(input),request:input}],{});
    const plan=await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql.text,sql.values.map(value=>value instanceof Date?value.toISOString():value));assert(plan.rows[0]['QUERY PLAN'][0].Plan);plans++;
    const detail=plan.rows[0]['QUERY PLAN'][0];
    console.log(`PLAN ${source.kind}${source.sort?':'+source.sort:''} rows=${result.length} executionMs=${detail['Execution Time']} root=${detail.Plan['Node Type']}`);}
  equal((await read(sources[0])).some(r=>r.candidate.id===draft.p.id),false,'Draft product excluded');
  equal((await read(sources[1]))[0].candidate.id,a.p.id,'Real popularity ordering');
  equal((await read({kind:'similar',productId:randomUUID()})).length,0,'Missing context target');
  equal((await read({kind:'similar',productId:draft.p.id})).length,0,'Unpublished context target');
  equal((await read({kind:'similar',productId:a.p.id})).some(r=>r.candidate.id===expensive.p.id),false,'Similarity real price band');
  equal((await read({kind:'complements',productId:a.p.id})).map(r=>r.candidate.id),[c.p.id],'Approved complement pair');
  equal((await read(sources[4],{asOf:new Date(now.getTime()+1)})).length,0,'Curated strict expiry boundary');
  await prisma.featuredItem.update({where:{id:featured.id},data:{startsAt:new Date(now.getTime()+1),expiresAt:new Date(now.getTime()+1000)}});
  equal((await read(sources[4])).length,0,'Future curated placement');
  const looks=await read(sources[8]);equal(looks.map(r=>r.candidate.id),[publicLook.id],'Public look plus minimum and 70-percent ratio');
  equal(JSON.stringify(looks).includes('PRIVATE'),false,'No private collection metadata');
  equal((await read(sources[7])).map(r=>r.candidate.id),[design.id],'Only public design anchors');
  equal((await read(sources[3],{filters:{colors:['red'],sizes:['M']}})).some(r=>r.candidate.id===b.p.id),false,'Low-stock obeys same SKU');
  const suppression=await prisma.userContentSuppression.create({data:{userId:viewer.id,targetType:'PRODUCT',targetId:a.p.id,sectionKey:'fixture',suppressionType:'HIDE_ITEM'}});
  equal((await read(sources[0],{}, {userId:viewer.id})).some(r=>r.candidate.id===a.p.id),false,'Current user product suppression');
  equal((await read(sources[0],{}, {userId:user.id})).some(r=>r.candidate.id===a.p.id),true,'Other viewer isolation');
  equal((await read(sources[0],{suppressionMode:'public_pool'}, {userId:viewer.id})).some(r=>r.candidate.id===a.p.id),true,'Shared source pool excludes viewer suppression');
  await prisma.userContentSuppression.delete({where:{id:suppression.id}});
  await prisma.collectionCategory.update({where:{id:category.id},data:{isActive:false}});
  equal((await read(sources[0])).find(r=>r.candidate.id===a.p.id).candidate.categoryId,null,'Inactive taxonomy not projected');
  equal((await read(sources[0],{filters:{categoryIds:[category.id]}})).length,0,'Inactive taxonomy cannot match user filter');
  await prisma.collectionCategory.update({where:{id:category.id},data:{isActive:true}});
  await prisma.brand.update({where:{id:brand.id},data:{isStoreOpen:false}});
  equal((await read(sources[0])).length,0,'Closed brand blocks products');equal((await read(sources[7])).length,0,'Closed brand blocks designs');
  await prisma.brand.update({where:{id:brand.id},data:{isStoreOpen:true}});
  await prisma.user.update({where:{id:user.id},data:{status:'SUSPENDED'}});
  equal((await read(sources[0])).length,0,'Suspended owner blocks products');equal((await read(sources[7])).length,0,'Suspended owner blocks designs');
  await prisma.user.update({where:{id:user.id},data:{status:'ACTIVE'}});
  const hidden=await prisma.userContentSuppression.create({data:{userId:viewer.id,targetType:'PRODUCT',targetId:a.p.id,sectionKey:'fixture',suppressionType:'HIDE_ITEM'}});
  const context={asOf:now,epoch,surface:'HOME',signedIn:true,filters:{},retentionHours:24,personalEnabled:false,regionalEnabled:false,
    suppression:{targetKeys:new Set(),brandIds:new Set(),categoryIds:new Set(),sectionKeys:new Set()},tenure:new Map()};
  const spec=parsePipelineSpec({key:'fixture',template:'CATALOG_FILTER',status:'ACTIVE',placement:{surface:'HOME',order:0}});
  const capture=await prisma.$transaction(tx=>captureMarketPipelinePage(tx,{specs:[spec],context,viewer:{userId:viewer.id}}),{isolationLevel:'RepeatableRead',timeout:10000});
  equal(capture.context.suppression.sectionKeys.has('fixture'),false,'Hiding an item never hides its source section');
  await prisma.userContentSuppression.delete({where:{id:hidden.id}});
  const extra=await runPipelineTransitions({db,prisma,now,equal,read,request,sources,user,viewer,brand,category,categoryB,garment,a,b,c,draft,design,designFile,publicLook,featured,tag,dimension,cotton,addProduct,capture});
  plans+=extra.plans;
  const scoped=await runMarketCatalogSourceScopeAssertions({db,prisma,now,queryCount,queryStats});
  checks+=scoped.checks;
  return {checks,plans};
}
module.exports={runPipelineFixture};
