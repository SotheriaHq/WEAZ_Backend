const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CollectionsService}=require('../src/collections/collections.service');
const {DesignsService}=require('../src/designs/designs.service');
const {LegacyCollectionDesignAdapter}=require('../src/designs/adapters/legacy-collection-design.adapter');
const {ContentIntegrityService}=require('../src/content-integrity/content-integrity.service');
const {resolveDesignTaxonomy}=require('../src/designs/design-taxonomy');
const {DEFAULT_NOTIFICATION_SETTINGS}=require('../src/notifications/notifications.types');

module.exports=async function verifyDesignTaxonomy({prisma,suggestions,categories,notifications,admin}){
  const cases=[],owner=randomUUID(),other=randomUUID();
  await prisma.user.createMany({data:[owner,other].map(id=>({id,username:id,email:`${id}@example.invalid`,type:'BRAND',isEmailVerified:true,notificationSettings:DEFAULT_NOTIFICATION_SETTINGS}))});
  await prisma.userProfile.createMany({data:[owner,other].map(userId=>({userId,firstName:'Taxonomy',lastName:'Fixture'}))});
  const brandId=randomUUID();
  await prisma.brand.create({data:{id:brandId,ownerId:owner,name:'Taxonomy fixture',contentReviewModeOverride:'PRE_REVIEW_REQUIRED'}});
  const fabricBasis=await prisma.customFabricRuleBasis.create({data:{label:'Taxonomy fixture',brandId}});
  const content=new ContentIntegrityService(prisma,notifications);
  content.getSubmission=id=>prisma.contentSubmission.findUniqueOrThrow({where:{id}});
  const collections=new CollectionsService(prisma,{}, {},{}, {},undefined,notifications,undefined,undefined,categories,undefined,undefined,undefined,undefined,content);
  const designs=new DesignsService(collections,{},new LegacyCollectionDesignAdapter());
  const name=`Garment ${owner.replaceAll('-','').slice(0,12)}`;
  const competing=await Promise.allSettled(Array.from({length:26},()=>suggestions.submit(owner,{name,garmentTypeName:'Day Jacket',description:'A distinct garment family for taxonomy verification.'})));
  assert.equal(competing.filter(item=>item.status==='fulfilled').length,1);
  const proposal=competing.find(item=>item.status==='fulfilled').value;
  assert.equal(proposal.garmentTypeName,'Day Jacket');
  assert.equal(await prisma.collectionCategorySuggestion.count({where:{slug:proposal.slug,garmentTypeSlug:'day-jacket'}}),1);
  cases.push('26 competing category/garment-type proposals create one pair identity, with no public category or garment type');
  const dimension=await prisma.filterDimension.create({data:{id:randomUUID(),slug:randomUUID(),name:'Design test detail',appliesTo:['COLLECTION']}});
  const detail=await prisma.filterValue.create({data:{id:randomUUID(),dimensionId:dimension.id,slug:'daywear',name:'Daywear'}});
  // A design cannot publish without a custom-order setup, so every fixture design has one.
  const draft=async(suggestionId=proposal.id)=>{
    const started=await designs.initializeDesignUpload(owner,{draftOnly:true,title:'Day jacket',type:'FEMALE',tags:['daywear'],filterValueIds:[detail.id],pendingCategorySuggestionId:suggestionId});
    await prisma.customOrderConfiguration.create({data:{brandId,sourceType:'DESIGN',sourceId:started.designId,title:'Taxonomy fixture',fabricRuleBasisId:fabricBasis.id,baseProductionCharge:100,fabricCostPerYard:0,productionLeadDays:1,deliveryMinDays:1,deliveryMaxDays:2,deliveryScope:'LOCAL',revisionPolicy:'Fixture',returnPolicy:'Fixture',defectPolicy:'Fixture',fabricSourcingMode:'BRAND_SOURCED'}});
    return started;
  };
  const created=await draft(),id=created.designId;
  assert(id);let current=await prisma.collection.findUniqueOrThrow({where:{id}});
  assert.equal(current.categoryId,null);assert.equal(current.categoryTypeId,null);assert.equal(current.pendingCategorySuggestionId,proposal.id);assert.equal(current.status,'DRAFT');
  await designs.updateDesign(id,owner,{description:'A relaxed jacket for everyday wear.'});
  current=await prisma.collection.findUniqueOrThrow({where:{id}});
  await designs.finalizeDesignUpload(id,owner,{action:'draft',completions:[],draftVersion:current.draftVersion,designMetadata:{title:'Everyday jacket'}});
  assert.equal((await prisma.collection.findUniqueOrThrow({where:{id}})).pendingCategorySuggestionId,proposal.id);
  await assert.rejects(()=>prisma.$transaction(tx=>resolveDesignTaxonomy(tx,{pendingCategorySuggestionId:proposal.id},{},{actorUserId:other,ownerUserId:other},true)),/not found/);
  cases.push('the actual design facade initializes, edits and saves a draft with its pending pair, keeps both public taxonomy keys empty and refuses another brand attaching that private proposal');
  async function addMedia(designId){
    const files=Array.from({length:4},()=>({id:randomUUID(),userId:owner,originalName:'jacket.jpg',fileName:'jacket.jpg',s3Key:randomUUID(),s3Url:'https://example.invalid/jacket.jpg',fileType:'POST_IMAGE',mimeType:'image/jpeg',size:100,processingStatus:'READY'}));
    await prisma.fileUpload.createMany({data:files});
    await prisma.collectionMedia.createMany({data:['FRONT','BACK','LEFT_SIDE','RIGHT_SIDE'].map((viewSlot,orderIndex)=>({id:randomUUID(),collectionId:designId,fileUploadId:files[orderIndex].id,orderIndex,viewSlot,mediaType:'POST_IMAGE'}))});
  }
  await addMedia(id);
  const publish=async()=>{const row=await prisma.collection.findUniqueOrThrow({where:{id}});return designs.finalizeDesignUpload(id,owner,{action:'publish',completions:[],draftVersion:row.draftVersion,designMetadata:{visibility:'PUBLIC'}});};
  await prisma.$executeRawUnsafe(`ALTER TABLE "Notification" ADD CONSTRAINT fixture_design_submit CHECK (NOT ("payload"->>'collectionId'='${id}'))`);
  try{
    await assert.rejects(publish, error=>/fixture_design_submit/.test([error.message,JSON.stringify(error.meta||{})].join(' ')));
    assert.equal((await prisma.collection.findUniqueOrThrow({where:{id}})).status,'DRAFT');
    assert.equal(await prisma.contentSubmission.count({where:{legacyCollectionId:id}}),0);
    assert.equal(await prisma.notification.count({where:{payload:{path:['collectionId'],equals:id}}}),0);
  }finally{await prisma.$executeRawUnsafe('ALTER TABLE "Notification" DROP CONSTRAINT fixture_design_submit');}
  await publish();
  const submitted=await prisma.collection.findUniqueOrThrow({where:{id}});
  assert.equal(submitted.status,'IN_REVIEW');assert.equal(submitted.categoryId,null);
  const submission=await prisma.contentSubmission.findFirstOrThrow({where:{legacyCollectionId:id}});
  assert.equal(await prisma.notification.count({where:{recipientId:owner,type:'CONTENT_SUBMITTED_FOR_REVIEW'}}),1);
  assert.equal(await prisma.notificationChannelOutbox.count({where:{notification:{recipientId:owner,type:'CONTENT_SUBMITTED_FOR_REVIEW'}}}),1);
  cases.push('a real inbox CHECK failure rolls back design publication and submission; retry atomically saves one review submission, one inbox and one channel intent');
  await content.reviewSubmission({submissionId:submission.id,adminUserId:admin,action:'approve'});
  assert.equal((await prisma.collection.findUniqueOrThrow({where:{id}})).status,'PUBLISHED');
  assert.equal((await prisma.collectionCategorySuggestion.findUniqueOrThrow({where:{id:proposal.id}})).status,'PENDING');
  assert.equal(await prisma.collection.count({where:{id,category:{slug:proposal.slug}}}),0);
  assert(!(await categories.listCategoriesWithSubCategories()).some(item=>item.slug===proposal.slug));
  cases.push('content approval publishes the design independently while the proposed category/type remains absent from public taxonomy and category-filtered content');
  const second=await draft();
  await suggestions.moderate(proposal.id,admin,{decision:'APPROVE'});
  const accepted=await prisma.collectionCategorySuggestion.findUniqueOrThrow({where:{id:proposal.id}});
  assert(accepted.approvedCategoryId);assert(accepted.approvedCategoryTypeId);
  const linked=await prisma.collection.findMany({where:{id:{in:[id,second.designId]}}});
  assert(linked.every(row=>row.categoryId===accepted.approvedCategoryId&&row.categoryTypeId===accepted.approvedCategoryTypeId&&row.pendingCategorySuggestionId===null));
  assert.equal(linked.find(row=>row.id===id).status,'PUBLISHED');assert.equal(linked.find(row=>row.id===second.designId).status,'DRAFT');
  assert.equal((await prisma.collectionCategoryType.findUniqueOrThrow({where:{id:accepted.approvedCategoryTypeId}})).categoryId,accepted.approvedCategoryId);
  cases.push('separate taxonomy approval resolves both related keys atomically, leaves a published design published and never publishes a linked draft');
  const newType=await suggestions.submit(owner,{name,garmentTypeName:'Evening Jacket',description:'Another garment type under the approved family.'});
  assert.equal(newType.status,'PENDING');
  await assert.rejects(()=>suggestions.submit(owner,{name,garmentTypeName:'Day Jacket'}),/already exists/);
  const rootOnly=await suggestions.submit(other,{name:`Garment ${other.replaceAll('-','').slice(0,12)}`,description:'A standalone category proposal.'});
  await assert.rejects(()=>prisma.$transaction(tx=>resolveDesignTaxonomy(tx,{pendingCategorySuggestionId:rootOnly.id},{},{actorUserId:other,ownerUserId:other},true)),/together/);
  cases.push('an existing category can receive a new pending garment-type proposal, an approved pair is refused as a duplicate, and root-only proposals remain supported but cannot satisfy design publish taxonomy');
  const direct=await draft(newType.id);
  await assert.rejects(()=>designs.submitDesignForReview(direct.designId,owner),error=>/media|image|view/i.test(error.message));
  assert.equal((await prisma.collection.findUniqueOrThrow({where:{id:direct.designId}})).status,'DRAFT');
  await addMedia(direct.designId);
  await designs.submitDesignForReview(direct.designId,owner);
  const directRow=await prisma.collection.findUniqueOrThrow({where:{id:direct.designId}});
  assert.equal(directRow.status,'IN_REVIEW');assert.equal(directRow.categoryId,null);assert.equal(directRow.pendingCategorySuggestionId,newType.id);
  const directSubmission=await prisma.contentSubmission.findFirstOrThrow({where:{legacyCollectionId:direct.designId}});
  await content.reviewSubmission({submissionId:directSubmission.id,adminUserId:admin,action:'approve'});
  await suggestions.moderate(newType.id,admin,{decision:'REJECT',rejectionReason:'Use a more specific garment type.'});
  const rejected=await prisma.collection.findUniqueOrThrow({where:{id:direct.designId}});
  assert.equal(rejected.status,'PUBLISHED');assert.equal(rejected.categoryId,null);assert.equal(rejected.categoryTypeId,null);
  assert.equal(rejected.originalSuggestionId,newType.id);assert.equal(rejected.pendingCategorySuggestionId,null);
  assert.equal((await prisma.collectionCategory.findUniqueOrThrow({where:{id:accepted.approvedCategoryId}})).isActive,true);
  cases.push('the direct design submit facade retains required-media checks and accepts a complete pending pair; rejecting that garment type never unpublishes approved content or disables its existing category');
  const punctuation=await prisma.collectionCategory.create({data:{id:randomUUID(),name:'Dresses & Gowns',slug:`stable-dresses-${randomUUID()}`,description:'Existing dresses category with a stable public identifier.'}});
  const punctuationRequest=await suggestions.submit(owner,{name:'Dresses & Gowns',garmentTypeName:'Fit-and-Flare',description:'A garment type under an existing approved category.'});
  assert.equal(punctuationRequest.slug,punctuation.slug);
  await suggestions.moderate(punctuationRequest.id,admin,{decision:'APPROVE'});
  const punctuationApproved=await prisma.collectionCategorySuggestion.findUniqueOrThrow({where:{id:punctuationRequest.id}});
  assert.equal(punctuationApproved.approvedCategoryId,punctuation.id);
  assert.equal(await prisma.collectionCategory.count({where:{name:'Dresses & Gowns'}}),1);
  const unicodeA=await suggestions.submit(other,{name:'类别甲',garmentTypeName:'日常外套',description:'An international garment family.'});
  const unicodeB=await suggestions.submit(other,{name:'类别乙',garmentTypeName:'日常外套',description:'A different international garment family.'});
  assert.notEqual(unicodeA.slug,unicodeB.slug);
  await assert.rejects(()=>suggestions.submit(other,{name:'Garment\u202Eunsafe',garmentTypeName:'Jacket'}),/letters/);
  const {plainToInstance}=require('class-transformer'),{validateSync}=require('class-validator');
  const {SubmitCategorySuggestionDto}=require('../src/categories/suggestions/dto/submit-category-suggestion.dto');
  assert.equal(validateSync(plainToInstance(SubmitCategorySuggestionDto,{name:'Dresses & Gowns',garmentTypeName:'Fit-and-Flare'})).length,0);
  assert.equal(validateSync(plainToInstance(SubmitCategorySuggestionDto,{name:'类别甲',garmentTypeName:'日常外套'})).length,0);
  cases.push('proposal DTOs accept real punctuation and international garment names, preserve an existing category’s stable slug, avoid non-Latin identity collisions and refuse directional-control injection');
  const raceRequest=await suggestions.submit(owner,{name,garmentTypeName:'Field Jacket',description:'A distinct garment type for the lock-wait test.'});
  const raceDraft=await draft(raceRequest.id);await addMedia(raceDraft.designId);
  let ready,release;
  const arrived=new Promise(resolve=>{ready=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  let paused=false,moderating,publishing;
  const gated=new Proxy(prisma,{get(target,key){
    if(key==='$transaction')return(work,options)=>target.$transaction(async tx=>{
      const result=await work(tx);
      const row=await tx.collection.findUnique({where:{id:raceDraft.designId}});
      if(!paused&&row.categoryId&&row.pendingCategorySuggestionId===null){paused=true;ready();await resume;}
      return result;
    },{...options,timeout:20_000});
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const gatedCollections=new CollectionsService(gated,{}, {},{}, {},undefined,notifications);
  const {CategorySuggestionsService}=require('../src/categories/suggestions/category-suggestions.service');
  const {AdminAuditService}=require('../src/admin/services/admin-audit.service');
  const gatedSuggestions=new CategorySuggestionsService(prisma,gatedCollections,new AdminAuditService(prisma));
  try{
    moderating=gatedSuggestions.moderate(raceRequest.id,admin,{decision:'APPROVE'});moderating.catch(()=>{});
    await Promise.race([arrived,moderating.then(()=>{throw Error('Taxonomy mutation did not reach its commit gate');})]);
    publishing=designs.finalizeDesignUpload(raceDraft.designId,owner,{action:'publish',completions:[],designMetadata:{visibility:'PUBLIC'}});publishing.catch(()=>{});
    let waiting=false;
    for(let i=0;i<200;i++){
      const rows=await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%content-review-source-lock%'`;
      if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert(waiting,'Actual publish must wait on taxonomy source mutation');
    release();await moderating;
    await assert.rejects(publishing,error=>error.getStatus?.()===409);
    const after=await prisma.collection.findUniqueOrThrow({where:{id:raceDraft.designId}});
    const approved=await prisma.collectionCategorySuggestion.findUniqueOrThrow({where:{id:raceRequest.id}});
    assert.equal(after.status,'DRAFT');assert.equal(after.categoryId,approved.approvedCategoryId);assert.equal(after.categoryTypeId,approved.approvedCategoryTypeId);
    assert.equal(await prisma.contentSubmission.count({where:{legacyCollectionId:after.id}}),0);
    assert.equal(await prisma.notification.count({where:{type:'CONTENT_SUBMITTED_FOR_REVIEW',payload:{path:['collectionId'],equals:after.id}}}),0);
  }finally{release();await Promise.allSettled([moderating,publishing].filter(Boolean));}
  cases.push('an actual publish lock waiter cannot overwrite a concurrently approved taxonomy pair or publish a stale draft; the losing request returns 409 with no review submission or false notice');
  return{cases};
};
