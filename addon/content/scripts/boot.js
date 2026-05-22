(function(){
sendAsyncMessage('patent:status',{stage:'boot_run',url:content.location.href});
sendAsyncMessage('patent:ready',{});
var Si=function(f,d){return content.setInterval(f,d)};
var Ci=function(i){return content.clearInterval(i)};
addMessageListener('patent:auto',function(m){
var k=m.data.keyword;if(!k)return;
try{
sendAsyncMessage('patent:status',{stage:'ss',kw:k});
var tr=function(s){return(s||'').replace(/\s+/g,'')};
var t=tr(content.document.body?content.document.body.textContent:'');
if(t.indexOf(tr(k))>=0){
sendAsyncMessage('patent:status',{stage:'has_content'});
var pub=t.match(/CN\s*\d+[A-Z]?/);
if(pub)sendAsyncMessage('patent:pdf',{pub:tr(pub[0])});
return;
}
var ii=null;
var ins=content.document.querySelectorAll('input[type="text"],input:not([type]),textarea');
for(var i=0;i<ins.length;i++){
var n=(ins[i].name||'').toLowerCase();
var id=(ins[i].id||'').toLowerCase();
var p=(ins[i].placeholder||'').toLowerCase();
if(n.indexOf('ti')>=0||n==='cataloginfo.ti'||id.indexOf('ti')>=0||p.indexOf('发明')>=0||p.indexOf('名称')>=0){
ii=ins[i];break;
}
}
if(!ii){sendAsyncMessage('patent:status',{stage:'err',msg:'Ti not found'});return;}
ii.value=k;
ii.dispatchEvent(new content.Event('input',{bubbles:true}));
ii.dispatchEvent(new content.Event('change',{bubbles:true}));
var sb=content.document.querySelector('.search-btn,.btn-search,input[type=submit],button[type=submit],button');
if(!sb){sendAsyncMessage('patent:status',{stage:'err',msg:'sbtn not found'});return;}
sb.click();
sendAsyncMessage('patent:status',{stage:'sd',inp:ii.name});
content._savedZl=[];
(function pz(c){
c++;
try{
var ze=content.document.querySelectorAll('[onclick*="zl_xm"]');
ze.forEach(function(el){
var oc=el.getAttribute('onclick')||'';
var p=oc.match(/'([^']+)'/g)||[];
if(p[0]){
var an=(p[0]||'').replace(/'/g,'');
if(!content._savedZl.some(function(x){return x.an===an;})){
content._savedZl.push({an:an,pt:(p[1]||'').replace(/'/g,''),ggr:(p[2]||'').replace(/'/g,'')});
}
}
});
if(content._savedZl.length>0||c>20){return;}
}catch(e){}
content.setTimeout(function(){pz(c);},800);
})(0);
}catch(e){
sendAsyncMessage('patent:status',{stage:'err',msg:'sS:'+e.message});
}
});
function stepDL(){
sendAsyncMessage('patent:status',{stage:'dl_loaded',url:content.location.href});
try{
var h2=content.document.documentElement.outerHTML||'';
sendAsyncMessage('patent:status',{stage:'dl_html',len:h2.length,preview:h2.substring(0,500)});
var bt=content.document.body?content.document.body.textContent:'';
sendAsyncMessage('patent:status',{stage:'dl_body',len:bt.length,preview:bt.substring(0,500)});
var h=content.document.documentElement.outerHTML||'';
var fm=h.match(/https?:\/\/egaz\.cnipa\.gov\.cn\/(filedl|showpdf)[^"'\s]*/);
if(fm){sendAsyncMessage('patent:pdf',{url:fm[0]});return;}
var la=content.document.querySelectorAll('a[href*="filedl"],a[href*="showpdf"],a[href*="egaz"]');
if(la.length>0){sendAsyncMessage('patent:pdf',{url:la[0].href});return;}
var wc=0;
var tmr=Si(function(){
wc++;
if(wc>30){Ci(tmr);sendAsyncMessage('patent:status',{stage:'err',msg:'dl timeout'});return;}
try{
var btns=content.document.querySelectorAll('button,a,input[type=button]');
var dl=null;
for(var i=0;i<btns.length;i++){
var bt=(btns[i].textContent||btns[i].value||'').toLowerCase();
if(bt.indexOf('下载')>=0||bt.indexOf('pdf')>=0){dl=btns[i];break;}
}
if(!dl)return;Ci(tmr);dl.click();sendAsyncMessage('patent:status',{stage:'dl_clicked'});
var w2=0;var t2=Si(function(){
w2++;if(w2>20){Ci(t2);sendAsyncMessage('patent:status',{stage:'err',msg:'captcha timeout'});return;}
try{
var txt=content.document.body.textContent||'';
var mt=txt.match(/(\d+)\s*([+\-])\s*(\d+)\s*=/);
if(!mt)return;Ci(t2);
var a=parseInt(mt[1],10),b=parseInt(mt[3],10),ans=mt[2]==='+'?a+b:a-b;
sendAsyncMessage('patent:status',{stage:'captcha',ans:ans});
var ai=content.document.querySelector('input[type="text"],input:not([type])');
if(ai){
ai.value=ans;
var oks=content.document.querySelectorAll('button,a,input[type=button]');
for(var oi=0;oi<oks.length;oi++){
var ot=(oks[oi].textContent||oks[oi].value||'').toLowerCase();
if(ot.indexOf('确定')>=0){oks[oi].click();sendAsyncMessage('patent:status',{stage:'captcha_ok'});break;}
}
}
}catch(e){sendAsyncMessage('patent:status',{stage:'err',msg:e.message});Ci(t2);}
},1e3);
}catch(e){sendAsyncMessage('patent:status',{stage:'err',msg:e.message});Ci(tmr);}
},1e3);
}catch(e){
sendAsyncMessage('patent:status',{stage:'err',msg:e.message});
}
}
var U=content.location.href;
if(U.indexOf('/Sw/SwDetail')>=0){stepDL();}
addMessageListener('patent:doNav',function(m){
try{
if(content._savedZl&&content._savedZl.length>0){
sendAsyncMessage('patent:navStatus',{stage:'use_saved',count:content._savedZl.length});
var s=content._savedZl[0];
var f=content.document.createElement('form');
f.method='POST';f.action='http://epub.cnipa.gov.cn/Sw/SwDetail';f.style.display='none';
var fn=function(n,v){var i=content.document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);};
fn('an',s.an);fn('pubType',s.pt);fn('ggr',s.ggr);
var ti=content.document.querySelector('input[name="__RequestVerificationToken"]');
if(ti)fn('__RequestVerificationToken',ti.value);
content.document.body.appendChild(f);f.submit();
sendAsyncMessage('patent:navStatus',{stage:'form_submitted',an:s.an});
return;
}
var tr2=function(s){return(s||'').replace(/\s+/g,'')};
var kw=m.data.keyword||'';
var ons=content.document.querySelectorAll('[onclick*="zl_xm"]');
sendAsyncMessage('patent:navStatus',{stage:'page_search',count:ons.length,kw:kw.substring(0,20)});
var targetBtn=null;var targetAn='';
for(var oi=0;oi<ons.length;oi++){
var oc=ons[oi].getAttribute('onclick')||'';
var p=oc.match(/'([^']+)'/g)||[];
var an=(p[0]||'').replace(/'/g,'');
if(!an)continue;
// 找按钮所在行是否包含关键词
var el=ons[oi];var ctx='';
for(var ci=0;ci<5&&el.parentElement;ci++){el=el.parentElement;ctx=tr2(el.textContent||'');}
var ctxMatch=kw?ctx.indexOf(tr2(kw))>=0:true;
sendAsyncMessage('patent:navStatus',{stage:'btn_check',idx:oi,an:an,ctxMatch:ctxMatch,ctx:ctx.substring(0,60)});
if(ctxMatch){targetBtn=ons[oi];targetAn=an;break;}
}
if(targetBtn){
var oc2=targetBtn.getAttribute('onclick')||'';
var p2=oc2.match(/'([^']+)'/g)||[];
var an2=(p2[0]||'').replace(/'/g,''),pt2=(p2[1]||'').replace(/'/g,''),ggr2=(p2[2]||'').replace(/'/g,'');
sendAsyncMessage('patent:navStatus',{stage:'matched',an:an2});
// 检查 token
var ti2=content.document.querySelector('input[name="__RequestVerificationToken"]');
sendAsyncMessage('patent:navStatus',{stage:'token_check',has:!!ti2,val:(ti2?ti2.value.substring(0,20):'')});
var body2='an='+encodeURIComponent(an2)+'&pubType='+pt2+'&ggr='+ggr2+(ti2?'&__RequestVerificationToken='+encodeURIComponent(ti2.value):'');
// 先 GET /Dxb/AdvancedQuery 获取新 token 和 session
var getXHR=new XMLHttpRequest();
getXHR.open('GET','http://epub.cnipa.gov.cn/Dxb/AdvancedQuery',false);
getXHR.send();
var tp2=getXHR.responseText.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
var freshToken=tp2?tp2[1]:'';
sendAsyncMessage('patent:navStatus',{stage:'fresh_token',has:!!freshToken});
var freshBody='an='+encodeURIComponent(an2)+'&pubType='+pt2+'&ggr='+ggr2+(freshToken?'&__RequestVerificationToken='+encodeURIComponent(freshToken):'');
var xhr2=new XMLHttpRequest();
xhr2.open('POST','http://epub.cnipa.gov.cn/Sw/SwDetail',true);
xhr2.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
xhr2.setRequestHeader('Referer','http://epub.cnipa.gov.cn/Dxb/AdvancedQuery');
xhr2.setRequestHeader('Origin','http://epub.cnipa.gov.cn');
xhr2.onload=function(){
var resp=xhr2.responseText||'';
sendAsyncMessage('patent:navStatus',{stage:'sw_resp',status:xhr2.status,len:resp.length,preview:resp.substring(0,500)});
if(resp){
var fm=resp.match(/https?:\/\/egaz\.cnipa\.gov\.cn\/(filedl|showpdf)[^"'\s]*/);
if(fm){sendAsyncMessage('patent:pdf',{url:fm[0]});return;}
var pm=resp.match(/\/filedl[^"'\s]*/);
if(pm){sendAsyncMessage('patent:pdf',{url:'http://egaz.cnipa.gov.cn'+pm[0]});return;}
}
};
xhr2.onerror=function(){sendAsyncMessage('patent:navStatus',{stage:'xhr_err'});};
xhr2.send(body2);
return;
}
sendAsyncMessage('patent:navStatus',{stage:'err',msg:'no zl_xm param'});
}catch(e){
sendAsyncMessage('patent:navStatus',{stage:'err',msg:e.message});
}
});
})();
