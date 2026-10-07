/* Shared native phone/tablet briefing presentation. Source of truth: ai-sync.
 * Rendering is read-only. Adapters own navigation and existing write actions. */
(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=v=>Array.isArray(v)?v:[];
  const values=v=>Object.values(v||{}).filter(x=>x&&!x.deleted&&!x.deletedAt);
  const url=v=>{try{const u=new URL(String(v));return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:''}catch(_){return ''}};
  function state(l){
    if(Object.hasOwn(l,'operationalStateSource')&&(l.operationalStateUnmapped||typeof l.operationalState!=='string'))return 'unknown';
    if(l.operationalState)return l.operationalState;
    if(l.status==='abgeschlossen'||l.closedAt)return 'done';
    if(l.assignee==='cowork')return l.returnedAt?'review':'delegated_cowork';
    if(l.pendingQuestion&&!l.pendingQuestion.answeredAt)return l.pendingQuestion.kind==='decision'?'decision_required':'information_required';
    return 'doing';
  }
  const closed=l=>['done','cancelled'].includes(state(l));
  function questionKind(l){if(closed(l)||!l.pendingQuestion?.text||l.pendingQuestion.answeredAt)return null;return [state(l),l.operationalStateSource?.legacyDesktopState,l.pendingQuestion.kind].some(v=>v==='decision_required'||v==='decision')?'decision':'information'}
  function color(l,now){
    const s=state(l),past=v=>Number.isFinite(Date.parse(v))&&Date.parse(v)<now;
    if(s==='unknown')return 'unknown';
    if((Number(l.followUpDeferrals)||0)>=3)return 'red';
    if(s==='delegated_cowork')return !l.expectedReturnAt||past(l.expectedReturnAt)||(l.returnedAt&&!l.returnChecked)?'red':'green';
    if(s==='waiting_external')return !l.waitingOn||!l.waitingSince||!l.nextAction||!l.followUpAt||past(l.followUpAt)?'red':'green';
    if(s==='followup_scheduled')return !l.followUpAt||past(l.followUpAt)?'red':'green';
    if(questionKind(l)||s==='review')return 'yellow';
    return !l.nextAction||past(l.nextActionAt)?'red':'yellow';
  }
  const section=(key,title,body,count,open=false)=>`<details class="qb-section" data-qb-section="${key}" ${open?'open':''}><summary><h2>${esc(title)}</h2>${count!==undefined?`<span class="qb-badge">${esc(count)}</span>`:''}</summary><div class="qb-body">${body||'<p class="qb-muted">Keine Einträge im geladenen Bestand.</p>'}</div></details>`;
  function model(data,date,now=Date.now()){
    const entities=data.entities||{},leads=values(entities.chatgptLeads),active=leads.filter(l=>!closed(l)),counts={green:0,yellow:0,red:0,unknown:0};
    active.forEach(l=>counts[color(l,now)]++);
    return {entities,leads,active,counts,run:data.dailyBriefing?.assistantRuns?.[date],
      decisions:active.filter(l=>questionKind(l)==='decision'),questions:active.filter(l=>questionKind(l)==='information'),
      cowork:active.filter(l=>['delegated_cowork','review'].includes(state(l))),
      tasks:values(entities.tasks).filter(t=>!['done','cancelled','completed','archived'].includes(t.status)&&!['chatgpt','cowork'].includes(t.assignee)).sort((a,b)=>String(a.dueDate||'9999').localeCompare(String(b.dueDate||'9999'))),
      projects:values(entities.projects).filter(p=>!['done','cancelled','archived'].includes(p.status))};
  }
  function render({data={},date,adapters={},pending=0,now=Date.now()}){
    const m=model(data,date,now),a=adapters;
    const entity=(collection,item)=>a.entity?a.entity(collection,item):`<span>${esc(item.title||item.name||'Original')}</span>`;
    const links=l=>'<div class="qb-links">'+[['linkedProjects','projects'],['linkedTasks','tasks'],['linkedNotes','notes'],['linkedOrganizations','organizations'],['linkedPersons','persons']].flatMap(([field,col])=>arr(l[field]).map(id=>m.entities[col]?.[id]).filter(x=>x&&!x.deleted&&!x.deletedAt).map(x=>entity(col,x))).join('')+arr(l.externalLinks).map(link=>url(link?.url)?`<a href="${esc(url(link.url))}" target="_blank" rel="noopener noreferrer">${esc(link.label||'Quelle öffnen')}</a>`:'').join('')+'</div>';
    const labels={green:'grün · im Plan',yellow:'gelb · offen',red:'rot · Aktion nötig',unknown:'ungeklärt'};
    const row=l=>`<article class="qb-row qb-${color(l,now)}"><h3>${entity('chatgptLeads',l)}</h3><p>${esc(l.lastAction||l.interpretation||'Noch kein Arbeitsstand dokumentiert.')}</p><p><b>Nächster Schritt:</b> ${esc(l.nextAction||l.blockedReason||l.waitingOn||'Noch nicht festgelegt.')}</p>${links(l)}<span class="qb-muted">${esc(labels[color(l,now)])}${l.followUpAt?' · Follow-up '+esc(l.followUpAt):''}</span></article>`;
    const qrow=l=>`<article class="qb-row"><h3>${entity('chatgptLeads',l)}</h3>${links(l)}<div data-legacy-question-lead="${esc(l.id)}" data-legacy-question-original="${esc(JSON.stringify(l.pendingQuestion))}"><p>${esc(l.pendingQuestion.text)}</p><div class="qb-links">${arr(l.pendingQuestion.options).filter(x=>typeof x==='string').map(o=>`<button type="button" data-qb-option="${esc(o)}">${esc(o)}</button>`).join('')}</div>${l.pendingQuestion.recommendation?`<p>Empfehlung: ${esc(l.pendingQuestion.recommendation)}</p>`:''}<input aria-label="Antwort" data-qb-field="answer-${esc(l.id)}" placeholder="Antwort oder Hinweis"><button type="button" data-qb-answer>Antwort sichern</button></div>${state(l)==='unknown'?'<p class="qb-muted">Arbeitsstatus ungeklärt; Frage bleibt offen.</p>':''}</article>`;
    const queued=m.active.filter(l=>l.status==='neu'&&!l.readAt);
    const slots=[['briefing04','04:00','Briefing'],['process09','09:00','Antworten'],['continue14','14:00','Fortsetzung'],['close23','23:00','Abschluss']];
    const html=`<div class="qb-dashboard"><header class="qb-hero ${m.counts.red?'qb-alert':''}"><h1>${m.decisions.length+m.questions.length} ${m.decisions.length+m.questions.length===1?'offene Frage':'offene Fragen'}</h1><p>Stand der geladenen Leads. Quellenprüfung und Synchronisierung separat prüfen.</p><div class="qb-counts">${Object.entries(m.counts).map(([k,n])=>`<span class="qb-pill"><i class="qb-dot ${k}"></i>${n} ${labels[k]}</span>`).join('')}</div><div class="qb-runs">${slots.map(([key,time,title])=>`<div><strong>${time}</strong><span>${title}</span><small>${m.run?.slotReceipts?.[key]?.receiptId?'Laufbeleg vorhanden':'Nicht bestätigt'}</small></div>`).join('')}</div><p class="qb-muted">${esc(date)} · Europe/Zurich · ${pending} lokale Änderung(en) warten auf Synchronisierung. Laufbelege sind keine aktuelle Vollständigkeitsprüfung.</p></header>
      ${section('capture','Neuer Lead',`<div class="qb-capture"><input aria-label="Titel" data-qb-field="title" placeholder="Titel" maxlength="200"><textarea aria-label="Auftrag" data-qb-field="text" placeholder="Was soll geschehen?" rows="3" maxlength="8000"></textarea><button type="button" class="primary" data-qb-submit>Erfassen</button></div>`,undefined,false)}
      ${section('queue','Warteschlange','<div data-qb-queue></div><p data-qb-status role="status"></p><button type="button" data-qb-retry>Übertragungen prüfen</button>'+queued.map(l=>`<div class="qb-row">${entity('chatgptLeads',l)}<p class="qb-muted">Lead erfasst · noch ungelesen</p></div>`).join('')+arr(data.dailyBriefing?.intakeQueue).filter(it=>!it.linkedLeadId).map(it=>`<p>${esc(it.text)}</p>`).join(''),queued.length+arr(data.dailyBriefing?.intakeQueue).filter(it=>!it.linkedLeadId).length,true)}
      <section class="qb-section"><div class="qb-body" data-qb-server>Automatische Fragen werden geladen …</div></section>
      ${section('decisions','Entscheidungen gefragt',m.decisions.map(qrow).join(''),m.decisions.length,true)}
      ${section('questions','Fragen von ChatGPT',m.questions.map(qrow).join(''),m.questions.length,true)}
      ${section('work','Pendent bei ChatGPT',m.active.filter(l=>!m.cowork.includes(l)).map(row).join(''),m.active.length-m.cowork.length,true)}
      ${section('cowork','Bei Claude Cowork',m.cowork.map(l=>row(l)+`<p class="qb-muted">Berechtigungen: Websuche ${l.grantedPermissions?.websuche?'ja':'nicht erteilt'} · Dateien ${l.grantedPermissions?.dateienErstellen?.erlaubt?'ja':'nicht erteilt'}. Rücklauf ${esc(l.returnedAt?(l.returnChecked?'geprüft':'ungeprüft'):'offen')}.</p>`).join(''),m.cowork.length)}
      ${section('documents','Dokumente','<p class="qb-muted">Am zugehörigen Lead anhängen. Hochgeladen bedeutet noch nicht geprüft.</p>'+m.leads.map(l=>`<details class="qb-document"><summary>${esc(l.title||'Lead')} · ${arr(l.files).length}</summary>${a.files?a.files(l):''}</details>`).join(''),m.leads.reduce((n,l)=>n+arr(l.files).length,0))}
      ${section('projects','Projektstände',m.projects.map(p=>{const related=m.active.filter(l=>arr(l.linkedProjects).includes(p.id)||l.projectId===p.id).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));return `<article class="qb-row"><h3>${entity('projects',p)}</h3><p>${esc(related[0]?.lastAction||p.description||'Kein Arbeitsstand dokumentiert.')}</p><p>Nächster Schritt: ${esc(related.find(l=>l.nextAction)?.nextAction||'Noch nicht festgelegt.')}</p>${related.map(l=>entity('chatgptLeads',l)).join('')}</article>`}).join(''),m.projects.length)}
      ${section('tasks','Meine Aufgaben',m.tasks.map(t=>a.task?a.task(t):entity('tasks',t)).join(''),m.tasks.length,true)}
      ${section('calendar','Termine',a.calendar||'<p>Kalenderstatus nicht verfügbar.</p>')}
      ${section('progress','App-Fortschritt und Updates','<p class="qb-muted">Smarter, RecallLab und Wochenlimit: kein verifizierter aktueller Messwert im Briefing.</p>'+(a.progress||''))}
      ${section('checks','Quellenprüfung',Object.entries(m.run?.sourceChecks||{}).map(([name,c])=>`<p><b>${esc(name)}</b> · ${esc(c.outcome||'ungeprüft')} · ${esc(c.checkedAt||'Zeitpunkt fehlt')}</p>`).join('')||'<p class="qb-muted">Keine Quellenprüfung für diesen Tag hinterlegt.</p>')}
      </div>`;
    return html;
  }
  root.QuantusBriefingDevice={render,model,state,questionKind,color,safeUrl:url,version:'2026-10-07'};
})(typeof window!=='undefined'?window:globalThis);
