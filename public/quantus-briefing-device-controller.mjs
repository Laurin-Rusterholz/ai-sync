import {openBriefingAnswers,bindBriefingAnswers,answerDeliveryText} from './quantus-v3-briefing-answers.mjs';
import {openQuickCapture,captureStatusText} from './quantus-v4-quick-capture.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createDeviceBriefingController({getUser,getData,origin,indexedDB=globalThis.indexedDB,fetchImpl=globalThis.fetch}) {
  const accounts=new Map();let dispose=()=>{};
  async function account(){
    const uid=getUser()?.uid;if(!uid)throw Error('sign_in_required');
    if(!accounts.has(uid)){
      const getAuth=async()=>{const u=getUser();if(u?.uid!==uid)return null;const idToken=await u.getIdToken();return getUser()?.uid===uid?{accountKey:uid,idToken}:null};
      const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      accounts.set(uid,Promise.all([
        openBriefingAnswers({accountKey:uid,getAuth,origin,indexedDB,fetchImpl,getQuestions:()=>getUser()?.uid===uid?Object.values(getData().automation?.questionsById||{}):[]}),
        openQuickCapture({accountKey:uid,getAuth,origin,indexedDB,fetchImpl,getRun:()=>getUser()?.uid===uid?getData().dailyBriefing?.assistantRuns?.[today()]:null})
      ]).then(([answers,capture])=>({uid,answers,capture,drafts:Object.create(null)})).catch(e=>{accounts.delete(uid);throw e}));
    }
    return accounts.get(uid);
  }
  async function mount(root){
    dispose();if(!root)return;
    let active=true,timer,busy=false;const uid=getUser()?.uid;
    const current=()=>active&&root.isConnected&&getUser()?.uid===uid;
    dispose=()=>{active=false;clearTimeout(timer);root.removeEventListener('click',click);root.removeEventListener('input',input)};
    const status=root.querySelector('[data-qb-status]'),queue=root.querySelector('[data-qb-queue]'),host=root.querySelector('[data-qb-server]');
    const say=text=>{if(current()&&status)status.textContent=text};
    let c;
    async function draw(){
      if(!current()||!c)return;
      const items=await c.capture.list(),answers=await c.answers.list();if(!current())return;
      queue.innerHTML=items.map(e=>'<p><b>'+esc(e.legacyOperation.payload.title)+'</b><br>'+esc(captureStatusText(e.deliveryStatus))+'</p>').join('')+answers.filter(e=>e.legacyOperation).map(e=>'<p>'+esc(answerDeliveryText(e.deliveryStatus||e.status))+'</p>').join('');
      await bindBriefingAnswers({host,client:c.answers,questions:Object.values(getData().automation?.questionsById||{}),drafts:c.drafts,isCurrent:current,legacyRoot:root});
      clearTimeout(timer);
      if(items.some(e=>e.deliveryStatus!=='acknowledged'))timer=setTimeout(async()=>{if(!current())return;try{await c.capture.flush();await draw()}catch(_){say('Übertragung offen. Eingaben bleiben auf diesem Gerät gesichert.')}},30000);
    }
    function input(e){if(!c||!current())return;const key=e.target.dataset.qbField;if(key)c.drafts[key]=e.target.value}
    async function click(e){
      const button=e.target.closest('[data-qb-submit],[data-qb-retry],[data-qb-answer],[data-qb-option]');if(!button||!root.contains(button)||busy)return;
      e.preventDefault();if(!c||!current()){say('Bitte in dieser App anmelden.');return}
      if(button.hasAttribute('data-qb-option')){const row=button.closest('[data-legacy-question-lead]'),field=row.querySelector('[data-qb-field]');field.value=button.dataset.qbOption;c.drafts[field.dataset.qbField]=field.value;return}
      busy=true;button.disabled=true;
      try{
        if(button.hasAttribute('data-qb-submit')){
          const fields={title:root.querySelector('[data-qb-field="title"]').value,text:root.querySelector('[data-qb-field="text"]').value};
          await c.capture.submit({captureId:crypto.randomUUID(),fields});
          if(!current())return;
          for(const key of ['title','text']){c.drafts[key]='';root.querySelector('[data-qb-field="'+key+'"]').value=''}
          say('Auf diesem Gerät gesichert · Serverbestätigung steht aus.');await draw();await c.capture.flush();
        }else if(button.hasAttribute('data-qb-answer')){
          const row=button.closest('[data-legacy-question-lead]'),question=JSON.parse(row.dataset.legacyQuestionOriginal),text=row.querySelector('[data-qb-field]').value;
          await c.answers.submitLegacy(row.dataset.legacyQuestionLead,question,text);say('Antwort auf diesem Gerät gesichert · Serverbestätigung steht aus.');await draw();await c.answers.flush();
        }else {await c.capture.flush();await c.answers.flush()}
        await draw();
      }catch(error){say(error?.code==='operation_id_conflict'?'Andere Antwort bereits gesichert. Der bisherige Text bleibt erhalten.':'Noch nicht bestätigt. Eingabe, Anmeldung und Übertragungen prüfen.')}finally{busy=false;if(current())button.disabled=false}
    }
    root.addEventListener('click',click);root.addEventListener('input',input);
    try{c=await account();if(!current())return;root.querySelectorAll('[data-qb-field]').forEach(el=>{el.value=c.drafts[el.dataset.qbField]||''});await draw()}
    catch(_){say('Bitte in dieser App anmelden, um Anfragen und Antworten dauerhaft zu sichern.');if(current()&&host)host.textContent='Automatische Fragen sind erst nach Anmeldung verfügbar.'}
  }
  return {mount,unmount:()=>dispose()};
}
