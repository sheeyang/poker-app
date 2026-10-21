// Real browser + evaluation-browser.ts (3036 control) + live-transport.ts.
(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const wait = async (predicate, label='condition') => { const end=Date.now()+12000; while (!await predicate()) { if(Date.now()>end) throw new Error('Timed out: '+label); await new Promise(resolve=>setTimeout(resolve,25)); } };
  const button = (text, doc=document) => [...doc.querySelectorAll('button')].find(item=>item.textContent===text);
  const click = (text, doc=document) => { const item=button(text,doc); check(item&&!item.disabled,text+' unavailable'); item.click(); };
  const request = async (path,body) => { const response=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined); const data=await response.json(); check(response.ok||data.status==='error',JSON.stringify(data)); return data; };
  const transport = body=>request('/api/__transport',body);
  const control = async kind=>(await fetch((globalThis.retryControl ?? 'http://127.0.0.1:3036')+'/'+kind)).json();
  const create = async()=>{ const previous=document.querySelector('.session-id')?.textContent; click('Create Table Session'); await wait(()=>document.querySelector('.session-id')?.textContent&&document.querySelector('.session-id').textContent!==previous&&document.body.textContent.includes('Live updates connected')); const id=document.querySelector('.session-id').textContent; const path='/api/table-sessions/'+id; const table=await request(path); for(const [index,binding] of table.bindings.slice(0,2).entries()) await request(path+'/seat-participant',{requestId:crypto.randomUUID(),expectedPokerRevision:index,participantId:binding.participantId,seat:index+1}); await request(path+'/start-hand',{requestId:crypto.randomUUID(),expectedPokerRevision:2}); await wait(()=>button('Evaluate current decision')&&!button('Evaluate current decision').disabled); return id; };
  const failed = (doc=document)=>doc.querySelector('.decision-analysis [role="alert"]')?.textContent.includes('failed');
  const complete = (doc=document)=>!!doc.querySelector('.evaluation-result');
  await wait(()=>document.body.textContent.includes('Local identity ready'));
  const first=await create(); await control('fail'); click('Evaluate current decision'); await wait(()=>failed());
  check(button('Retry evaluation'),'Failed evaluation has no Retry control');
  const firstFailure=(await transport()).frames[first].find(frame=>frame.type==='analysis-update');
  await control('hold'); await transport({kind:'hold',tableSessionId:first,responseKind:'analysis-read'}); click('Evaluate current decision');
  await wait(async()=>(await transport()).held.includes(first+':analysis-read'));
  click('Retry evaluation'); await wait(async()=>(await control('')).evaluations>=2);
  check(!button('Fold').disabled,'Retry blocked legal play'); await control('release');
  await wait(async()=>(await transport()).frames[first].some(frame=>frame.type==='analysis-update'&&frame.status==='complete'));
  await transport({kind:'release',tableSessionId:first,responseKind:'analysis-read'}); await wait(()=>complete(),'local Retry survives old HTTP failure');
  const before=(await transport()).requests; await transport({kind:'replay-analysis',tableSessionId:first,requestId:firstFailure.requestId});
  await new Promise(resolve=>setTimeout(resolve,150)); check(complete()&&!failed(),'Old attempt notification replaced successful Retry');
  check(JSON.stringify((await transport()).requests)===JSON.stringify(before),'Known old attempt caused another fetch');

  const second=await create(); await control('fail'); click('Evaluate current decision'); await wait(()=>failed());
  const peer=window.open(location.href,'m2-retry-peer'); check(peer,'Peer browser tab unavailable');
  try {
    await wait(()=>peer.document.body.textContent.includes('Live updates connected')&&button('Evaluate current decision',peer.document)&&!button('Evaluate current decision',peer.document).disabled,'peer table');
    click('Evaluate current decision',peer.document); await wait(()=>failed(peer.document),'peer sees same failure');
    await transport({kind:'hold',tableSessionId:second,responseKind:'analysis-read'}); click('Evaluate current decision');
    await wait(async()=>(await transport()).held.includes(second+':analysis-read'));
    await control('hold'); click('Retry evaluation',peer.document); await wait(()=>peer.document.querySelector('.decision-analysis')?.textContent.includes('Evaluating'));
    await control('release'); await wait(async()=>(await transport()).frames[second].some(frame=>frame.type==='analysis-update'&&frame.status==='complete'),'peer Retry server completion');
    await transport({kind:'release',tableSessionId:second,responseKind:'analysis-read'});
    await wait(()=>complete()&&!failed()&&complete(peer.document),'other-tab Retry discovered despite held old failure');
  } finally { peer.close(); }
  const reads={...(await transport()).requests}; await new Promise(resolve=>setTimeout(resolve,650));
  check(JSON.stringify((await transport()).requests)===JSON.stringify(reads),'Retry introduced polling');
  return {passed:true,cases:['failed-only Retry control','local Retry versus held old response','nonblocking play','known old attempt rejection','other-tab Retry versus held old failure','no polling']};
})
