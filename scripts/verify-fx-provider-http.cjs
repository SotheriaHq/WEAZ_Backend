// Run against the local Postman simulation; the production FX code makes real HTTP requests.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {Prisma}=require('@prisma/client');
require('ts-node').register({transpileOnly:true});require('tsconfig-paths/register');
const {FxMarketRates}=require('../src/payment/fx-market-rates');
const {FxRateService}=require('../src/payment/fx-rate.service');
const url=process.env.FX_SIMULATION_URL||'http://127.0.0.1:4905/frankfurter';
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname),'Loopback simulation required');
const control=async mode=>{
  const response=await fetch(`${url}/__control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode}),signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
};
const stats=async()=>await (await fetch(`${url}/__stats`,{signal:AbortSignal.timeout(3000)})).json();
async function main(){
  const evidence={checkedAt:new Date().toISOString(),passed:false,cases:[]};
  const originalUrl=process.env.FX_RATE_API_URL;const originalNow=Date.now;
  process.env.FX_RATE_API_URL=url;
  try{
    await control('valid');
    const stored=[];
    const prisma={exchangeRateSnapshot:{create:async({data})=>{stored.push(data);return data;},findUnique:async()=>null}};
    const service=new FxRateService(prisma);
    const quotes=await Promise.all(Array.from({length:120},()=>service.getQuotePreview({from:'USD',to:'NGN',amount:2})));
    assert(quotes.every(quote=>quote.convertedAmount===3000));assert.equal((await stats()).requests,1);
    evidence.cases.push('120 concurrent quotes share one real HTTP table request and exact USD->NGN conversion');
    const gh=await service.getDisplayRates({country:'Ghana'});
    assert.equal(gh.displayCurrency,'GHS');assert.equal(gh.baseCurrency,'NGN');assert.equal(gh.rates.NGN.rate,1);
    assert.equal(gh.rates.GHS.rate,0.008);assert.equal(gh.isEstimate,true);
    assert.equal((await service.getDisplayRates({country:'GH',currency:'GBP'})).displayCurrency,'GBP');
    const multiple=await service.getDisplayRates({country:'PA'});
    assert.equal(multiple.needsCurrencyChoice,true);assert.equal(multiple.displayCurrency,'NGN');
    assert.equal((await service.getDisplayRates({country:'not-a-country'})).displayCurrency,'NGN');
    evidence.cases.push('country selection, explicit override, multi-currency choice and unknown-country base fallback');
    const locked=await service.quoteAndPersist({from:'USD',amount:2});
    assert.equal(locked.snapshot.rate.toFixed(8),'1500.00000000');assert.equal(locked.convertedAmount.toFixed(2),'3000.00');
    const settled=await service.resolveSettlement({attempt:{currency:'USD',amount:new Prisma.Decimal(2),exchangeRateSnapshotId:locked.snapshot.id,exchangeRateSnapshot:locked.snapshot},gateway:'PAYSTACK',payload:{rate:999}});
    assert.equal(settled.settlementAmount.toFixed(2),'3000.00');assert.equal(settled.exchangeRateSnapshotId,locked.snapshot.id);
    await assert.rejects(service.resolveSettlement({attempt:{currency:'USD',amount:new Prisma.Decimal(2)},gateway:'PAYSTACK',payload:{rate:999}}),/FX_ORIGINAL_PAYMENT_SNAPSHOT_REQUIRED/);
    await assert.rejects(service.resolveSettlement({attempt:{currency:'USD',amount:new Prisma.Decimal(2),exchangeRateSnapshotId:locked.snapshot.id,exchangeRateSnapshot:{...locked.snapshot,baseCurrency:'NGN',quoteCurrency:'USD'}},gateway:'PAYSTACK'}),/FX_ORIGINAL_PAYMENT_SNAPSHOT_INVALID/);
    assert.equal((await stats()).requests,1);
    evidence.cases.push('persisted precision is reused for settlement; changed payload, missing and reversed snapshots cannot reprice money');
    await control('unavailable');
    const cachedTime=Date.now();Date.now=()=>cachedTime+2*3600000;
    const stale=await service.getDisplayRates({country:'GH'});
    assert.equal(stale.isStale,true);
    const snapshotsBefore=stored.length;
    await assert.rejects(service.quoteAndPersist({from:'USD',amount:2}),/FX_RATES_TEMPORARILY_UNAVAILABLE/);
    assert.equal(stored.length,snapshotsBefore);assert.equal((await stats()).requests,1);
    Date.now=()=>cachedTime+73*3600000;
    await assert.rejects(service.getDisplayRates({country:'GH'}),/FX_RATES_TEMPORARILY_UNAVAILABLE/);
    Date.now=originalNow;
    evidence.cases.push('outage allows explicitly stale display within 72 hours, blocks new financial snapshots and rejects older cache');
    for(const mode of ['invalid','wrong-base','duplicate','old','html','rate-limit']){
      await control(mode);const market=new FxMarketRates(url);
      await assert.rejects(market.pair('USD','NGN'),/FX_RATES_TEMPORARILY_UNAVAILABLE/);
      await Promise.all(Array.from({length:25},()=>assert.rejects(market.pair('USD','NGN'),/FX_RATES_TEMPORARILY_UNAVAILABLE/)));
      assert.equal((await stats()).requests,1);
    }
    evidence.cases.push('negative/foreign-base/duplicate/old/HTML/429 responses fail safely with bounded retry backoff');
    await control('hanging');const hanging=new FxMarketRates(url);const started=Date.now();
    await assert.rejects(hanging.pair('USD','NGN'),/FX_RATES_TEMPORARILY_UNAVAILABLE/);
    assert(Date.now()-started<6200,'HTTP abort must bound a hanging provider');
    evidence.cases.push('hanging upstream is aborted within the five-second HTTP budget');
    await assert.rejects(new FxMarketRates('http://127.0.0.1:1').pair('USD','NGN'),/FX_RATES_TEMPORARILY_UNAVAILABLE/);
    evidence.cases.push('unreachable provider produces a controlled unavailable response');
    evidence.passed=true;
  }finally{
    Date.now=originalNow;
    if(originalUrl===undefined)delete process.env.FX_RATE_API_URL;else process.env.FX_RATE_API_URL=originalUrl;
    await fs.writeFile('docs/performance-reviews/fx-provider-http-2026-10-23.json',JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
