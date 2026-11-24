const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {MarketCatalogService}=require('../../src/market/catalog/market-catalog.service');
const {MarketCatalogReadService}=require('../../src/market/catalog/market-catalog-read.service');
const {MarketPublicMediaService}=require('../../src/market/catalog/market-public-media.service');
const {createMarketCatalogScope}=require('../../src/market/catalog/market-catalog-scope');
const {mapLegacyMarketPage}=require('../../src/market/catalog/market-legacy-facade');

async function runMarketCatalogMediaAssociationAssertions({db,prisma,chosen,owner,brand,firstFile,backFile,config}){
  assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(db.connectionParameters.database));
  let checks=0;
  const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
  const other=await prisma.product.create({data:{id:randomUUID(),brandId:brand.id,name:'Shared-file other product',price:9000,publicationStatus:'PUBLISHED',isActive:true,totalStock:1,standardCheckoutEnabled:true,firstPublishedAt:new Date(Date.now()-1000),thumbnail:firstFile.s3Url,images:[firstFile.s3Url,backFile.s3Url]}});
  await prisma.productMedia.createMany({data:[{productId:other.id,fileUploadId:firstFile.id,brandId:brand.id,createdById:owner.id,viewSlot:'FRONT',reviewStatus:'APPROVED',orderIndex:0},{productId:other.id,fileUploadId:backFile.id,brandId:brand.id,createdById:owner.id,viewSlot:'BACK',reviewStatus:'APPROVED',orderIndex:1}]});
  const scope=createMarketCatalogScope({key:'shared-media-proof',version:'1',viewer:{},productIds:[chosen.id,other.id]});
  async function readAfter(mutate){
    const reads=new MarketCatalogReadService(prisma),media=new MarketPublicMediaService(reads,config);
    let once=false;
    const boundary={resolve:async(authorize,options)=>{if(!once){once=true;await mutate();}return media.resolve(authorize,options);}};
    const catalogue=new MarketCatalogService(reads,boundary,config);
    const result=await catalogue.getPage(new URLSearchParams('sort=newest&limit=10'),{},{scope,fixedFilters:{},includeTotal:true,includeLegacyOptions:true});
    assert(once,'Mutation must happen between capture and current-media authorization');
    return mapLegacyMarketPage(result);
  }
  const first=await prisma.productMedia.findFirst({where:{productId:chosen.id,fileUploadId:firstFile.id}});
  const missingCover=await readAfter(()=>prisma.productMedia.delete({where:{id:first.id}}));
  equal(missingCover.items.map(item=>item.id),[other.id],'Another public product cannot authorize a removed product cover association');
  equal(missingCover.items[0].media.some(media=>media.fileId===firstFile.id),true,'The remaining legitimate product keeps its own shared cover');
  await prisma.productMedia.create({data:{productId:chosen.id,fileUploadId:firstFile.id,brandId:brand.id,createdById:owner.id,viewSlot:'FRONT',reviewStatus:'APPROVED',orderIndex:0}});
  const back=await prisma.productMedia.findFirst({where:{productId:chosen.id,fileUploadId:backFile.id}});
  const missingGallery=await readAfter(()=>prisma.productMedia.delete({where:{id:back.id}}));
  equal(missingGallery.items.length,2,'Removing a non-cover view preserves both valid cards');
  equal(missingGallery.items.find(item=>item.id===chosen.id).media.map(media=>media.fileId),[firstFile.id],'A removed gallery association stays removed even while another card authorizes that file');
  equal(missingGallery.items.find(item=>item.id===other.id).media.map(media=>media.fileId),[firstFile.id,backFile.id],'The other product retains its complete approved gallery');
  await prisma.productMedia.create({data:{productId:chosen.id,fileUploadId:backFile.id,brandId:brand.id,createdById:owner.id,viewSlot:'BACK',reviewStatus:'APPROVED',orderIndex:1}});
  const replaced=await readAfter(()=>prisma.fileUpload.update({where:{id:firstFile.id},data:{assetVersion:2}}));
  equal(replaced.items,[],'A replacement asset version cannot inherit a captured cover authorization');
  await prisma.fileUpload.update({where:{id:firstFile.id},data:{assetVersion:1}});
  console.log(`PASS ${checks} exact product-file-version association withdrawal proofs`);
  return {checks};
}
module.exports={runMarketCatalogMediaAssociationAssertions};
