// Tests the deployed source tree against a disposable local DB. No real SAT,
// PAC, billing, or external messaging credentials are used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');
const { encode } = await import(require.resolve('next-auth/jwt'));
const origin = process.env.ONBOARDING_SMOKE_ORIGIN ?? 'http://127.0.0.1:3221';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Local origin required');
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://invalid/blocked';
const secret = process.env.AUTH_SECRET;
assert(secret?.startsWith('onboarding-synthetic-'), 'Synthetic auth secret required');
assert(new URL(databaseUrl).hostname === '127.0.0.1' && new URL(databaseUrl).pathname.endsWith('_test'));
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const out = (process.env.ONBOARDING_SMOKE_ARTIFACTS ?? '/tmp/onboarding-recovery-browser').replace(/\/$/, '') + '/';
const tag = `onb-${randomUUID().slice(0, 8)}`;
const results = [], users = [], companies = [], despachos = [];
const allErrors = [], screenshots = [];
let browser, page, owner, company;
const pause = (ms) => new Promise(r => setTimeout(r, ms));
async function screenshot(name, p=page) {
  const file = `${name}.png`;
  await pause(400);
  await p.screenshot({path: out+file, fullPage:true, mask:[p.locator('.ob-sent code')]});
  screenshots.push(file); return file;
}
async function record(name, fn) {
  console.log(`RUN ${name}`);
  try { const detail=await fn(); results.push({name,status:'PASS',...detail}); }
  catch(e) {
    let evidence;
    try { evidence=await screenshot(`failure-${results.length}`); } catch {}
    results.push({name,status:'FAIL',error:String(e),evidence});
    console.log(`FAIL ${name}: ${e.message}`);
  }
  await writeFile(out+'results.json',JSON.stringify({tag,results,allErrors,screenshots},null,2));
}
async function newUser(kind, onboarding) {
  const id=`${tag}-${kind}`;
  const u=await prisma.user.create({data:{id,email:`${id}@onboarding.invalid`,name:`Synthetic ${kind}`,subscriptionStatus:'ACTIVE',...(onboarding?{onboarding}:{} )}});
  users.push(id);
  await prisma.legalAcceptance.createMany({data:['TERMINOS','AVISO_PRIVACIDAD'].map(documento=>({userId:id,documento,version:'2026-09-03',contexto:'synthetic-onboarding-browser-test'}))});
  return u;
}
async function newContext(u, mobile=false) {
  const c=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:950},reducedMotion:'reduce',serviceWorkers:'block'});
  await c.route('**/*', r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const token=await encode({secret,salt:'authjs.session-token',maxAge:3600,token:{sub:u.id,id:u.id,email:u.email,name:u.name}});
  await c.addCookies([{name:'authjs.session-token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
  c.on('page',p=>{p.setDefaultTimeout(15000);p.on('pageerror',e=>allErrors.push({user:u.id,url:p.url(),message:e.message}));});
  return c;
}
async function progress(u) { return (await prisma.user.findUnique({where:{id:u.id},select:{onboarding:true}})).onboarding; }
async function setProgress(u, patch) { return prisma.user.update({where:{id:u.id},data:{onboarding:{paso:'fiel',companyId:null,perfil:'empresa',tono:'calma',tonoElegido:true,...patch}}}); }
async function freshPage(u, url='/onboarding', mobile=false) {
  const c=await newContext(u,mobile); const p=await c.newPage();
  await p.goto(origin+url,{waitUntil:'domcontentloaded'}); return p;
}
function mockFiel(p, {rfc='SYN261001A01', mode='normal'}={}) {
  let aborted = false;
  return p.route('**/api/onboarding/fiel', async route=>{
    const {accion}=route.request().postDataJSON();
    const info={rfc,razonSocial:`SYNTHETIC ONBOARDING ${tag}`,validoHasta:'2030-10-01T00:00:00Z',esFiel:true,vigente:true};
    if(accion==='leer') return route.fulfill({json:info});
    if(accion==='validar') {
      if(mode==='network-error' && !aborted) { aborted = true; return route.abort('failed'); }
      if(mode==='wrong-password') return route.fulfill({json:{...info,ok:false,error:'Contraseña incorrecta (simulada)',checks:{esFiel:true,vigente:true,llave:false}}});
      return route.fulfill({json:{...info,ok:true,checks:{esFiel:true,vigente:true,llave:true}}});
    }
    return route.fulfill({json:{datos:null,motivo:'Simulated SAT unavailable; manual fallback required'}});
  });
}
async function uploadSynthetic(p) {
  await p.locator('input[type=file][accept=".cer"]').setInputFiles({name:'synthetic-only.cer',mimeType:'application/octet-stream',buffer:Buffer.from('NOT A REAL CERTIFICATE')});
  await p.getByText(/SYNTHETIC ONBOARDING/).first().waitFor();
  await p.locator('input[type=file][accept=".key"]').setInputFiles({name:'synthetic-only.key',mimeType:'application/octet-stream',buffer:Buffer.from('NOT A REAL PRIVATE KEY')});
  await p.getByPlaceholder('Contraseña de la llave privada',{exact:true}).fill('synthetic-only-password');
  assert(await p.getByRole('button',{name:'Conectar con el SAT',exact:true}).isDisabled());
  await p.getByRole('checkbox').check();
}
async function connectWithStubbedSat(p,rfc) {
  await mockFiel(p,{rfc});
  // Provider/certificate boundary is simulated. All company/progress/bank
  // persistence is real in the local DB; no credential is ever saved.
  await p.route('**/api/companies',async route=>{
    if(route.request().method()!=='POST') return route.fallback();
    const body=route.request().postDataJSON();
    delete body.fielCer;delete body.fielKey;delete body.fielPassword;delete body.aceptaMandatoEfirma;
    const res=await route.fetch({postData:body});
    if(res.ok()) companies.push((await res.json()).id);
    await route.fulfill({response:res});
  });
  await p.route('**/api/onboarding/opinion',r=>r.fulfill({status:503,json:{error:'Synthetic SAT outage'}}));
  await uploadSynthetic(p);
  await p.getByRole('button',{name:'Conectar con el SAT',exact:true}).click();
  await p.getByText('Confirma 2 datos',{exact:true}).waitFor();
  assert(await p.getByRole('button',{name:'Confirmar y conectar',exact:true}).isDisabled());
  await p.getByRole('combobox',{name:'Régimen fiscal',exact:true}).selectOption('601');
  await p.getByPlaceholder('Código postal del domicilio fiscal',{exact:true}).fill('06600');
  const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/companies'&&r.request().method()==='POST');
  await p.getByRole('button',{name:'Confirmar y conectar',exact:true}).click();
  const res=await response; assert.equal(res.status(),201,await res.text());
  await p.getByRole('heading',{name:/Traigo .* de tu historial del SAT/}).waitFor({timeout:30000});
  return await res.json();
}
async function assertNoOverflow(p) {
  const d=await p.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert(d.document<=d.viewport+1&&d.body<=d.viewport+1,JSON.stringify(d));return d;
}
try {
  await mkdir(out,{recursive:true}); browser=await chromium.launch({headless:true});
  owner=await newUser('owner'); page=await freshPage(owner);
  await record('First-time welcome, profile, personalization, desktop/mobile layout',async()=>{
    await page.getByRole('heading',{name:'Hola. Yo te acompaño a dar de alta tu contabilidad.',exact:true}).waitFor();
    await screenshot('01-welcome-desktop');
    await page.getByRole('button',{name:/Es mi empresa/}).click();
    await page.getByRole('heading',{name:'Elige cómo quieres que me vea',exact:true}).waitFor();
    await page.getByLabel('Nombre',{exact:true}).fill('Test Mochi');
    await page.getByRole('button',{name:/Al grano/}).click();
    await pause(250);
    console.log('Saved personalization before reload:',JSON.stringify(await progress(owner)));
    await page.reload();
    await page.getByRole('heading',{name:'Elige cómo quieres que me vea',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Nombre',{exact:true}).inputValue(),'Test Mochi');
    const saved=await progress(owner);assert.equal(saved.paso,'personaje');assert.equal(saved.tono,'grano');assert.equal(saved.perfil,'empresa');
    await page.setViewportSize({width:390,height:844});await assertNoOverflow(page);
    await screenshot('02-companion-mobile');
    await page.getByRole('button',{name:'Así me gusta',exact:true}).click();
    await page.getByRole('button',{name:'Entendido, sigamos',exact:true}).click();
    await page.getByRole('heading',{name:'Conecta tu e.firma',exact:true}).waitFor();
    await screenshot('03-efirma-mobile');
    await page.setViewportSize({width:1365,height:950});
    return {saved};
  });
  // Keep later checks independent if a progress bug sent the user backward.
  if (!(await page.getByRole('heading',{name:'Conecta tu e.firma',exact:true}).isVisible().catch(()=>false))) {
    console.log('Independent fixture reset to e.firma after earlier flow failure');
    await setProgress(owner,{paso:'fiel'});
    await page.goto(origin+'/onboarding');
    await page.getByRole('heading',{name:'Conecta tu e.firma',exact:true}).waitFor();
  }
  await record('Invalid certificate rejected by real backend',async()=>{
    await page.locator('input[type=file][accept=".cer"]').setInputFiles({name:'invalid.cer',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')});
    await page.getByText(/El archivo .cer no se pudo leer/).first().waitFor();
    assert(await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).isDisabled());
  });
  await record('CSF/outage fallback, company creation, pending opinion, persisted history',async()=>{
    company=await connectWithStubbedSat(page,`SYA261001${tag.slice(-3).toUpperCase()}`);
    const stored=await prisma.company.findUnique({where:{id:company.id}});
    assert.equal(stored.fielCer,null);assert.equal(stored.regimenFiscal,'601');assert.equal(stored.codigoPostal,'06600');
    await pause(200);
    assert.equal((await progress(owner)).companyId,company.id);
    await screenshot('04-history-desktop');
    await page.reload();
    await page.getByRole('heading',{name:/Traigo .* de tu historial del SAT/}).waitFor();
    await page.getByRole('button',{name:'¿Cuántos años?',exact:true}).click();
    await page.getByRole('button',{name:'1',exact:true}).click();
    await page.getByRole('heading',{name:'Traigo 1 año de tu historial del SAT',exact:true}).waitFor();
    assert.equal((await prisma.company.findUnique({where:{id:company.id}})).satBackfillYears,1);
    await page.setViewportSize({width:390,height:844});await assertNoOverflow(page);
    await screenshot('05-history-mobile');
    await page.getByRole('button',{name:/Seguir,/}).click();
    await page.getByRole('heading',{name:'Registra tu cuenta de banco',exact:true}).waitFor();
    return {companyId:company.id,sat:'simulated',persistence:'real local DB'};
  });
  await record('Bank validation rejects a three-digit CLABE',async()=>{
    await page.getByRole('button',{name:/BBVA/}).click();
    await page.getByPlaceholder('Número de cuenta',{exact:true}).fill('0000000001');
    await page.getByPlaceholder('CLABE (opcional)',{exact:true}).fill('123');
    const wait=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/bancos'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Registrar cuenta',exact:true}).click();
    const res=await wait;const body=await res.json();
    if(res.ok()) {await screenshot('06-invalid-clabe-accepted');throw new Error(`Invalid CLABE accepted and persisted: ${body.clabe}, HTTP ${res.status()}`);}
    assert.equal(res.status(),400);
  });
  await record('Valid bank creation and optional synthetic teammate access',async()=>{
    await page.reload();await page.getByRole('heading',{name:'Registra tu cuenta de banco',exact:true}).waitFor();
    await page.getByRole('button',{name:/BBVA/}).click();
    await page.getByPlaceholder('Número de cuenta',{exact:true}).fill('0000000002');
    await page.getByRole('button',{name:'Registrar cuenta',exact:true}).click();
    await page.getByText(/0002 registrada/).waitFor();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByRole('heading',{name:'Invita a tu contador',exact:true}).waitFor();
    const email=`${tag}-teammate@onboarding.invalid`;
    await page.getByPlaceholder('correo@tucontador.mx',{exact:true}).fill(email);
    await page.getByRole('combobox',{name:'Rol',exact:true}).selectOption('VIEWER');
    await page.getByRole('button',{name:'Dar acceso',exact:true}).click();
    await page.getByText(email,{exact:false}).first().waitFor();
    const teammate=await prisma.user.findUnique({where:{email}});assert(teammate);users.push(teammate.id);
    assert.equal((await prisma.companyMember.findFirst({where:{companyId:company.id,userId:teammate.id}})).role,'VIEWER');
    await screenshot('07-team-mobile');
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.waitForURL(/\/dashboard/,{timeout:30000});
  });
  await record('Mobile tour and app handoff',async()=>{
    await page.getByRole('dialog',{name:/Recorrido:/}).waitFor({timeout:30000});
    await screenshot('08-tour-mobile');
    const first=await page.getByRole('dialog',{name:/Recorrido:/}).getAttribute('aria-label');
    await page.getByRole('button',{name:'Saltar recorrido',exact:true}).click();
    await page.getByRole('heading',{name:'Descarga la app',exact:true}).waitFor();
    await screenshot('09-install-mobile');
    await page.getByRole('button',{name:'Listo, ir a mi tablero',exact:true}).click();
    await pause(300);assert.equal((await progress(owner)).paso,'listo');
    await page.reload();assert.equal(await page.getByRole('dialog',{name:/Recorrido:/}).count(),0);
    return {firstTourStep:first,install:'instructions only, native installation not exercised'};
  });
  await record('Additional-company resume survives reload',async()=>{
    page=await freshPage(owner,'/onboarding?from=empresas');
    await page.getByRole('heading',{name:'Conecta tu e.firma',exact:true}).waitFor();
    const c=await connectWithStubbedSat(page,`SYB261001${tag.slice(-3).toUpperCase()}`);
    await screenshot('10-add-company-history');
    await page.reload();
    await page.getByRole('heading').first().waitFor();
    const history=await page.getByRole('heading',{name:/Traigo .* de tu historial del SAT/}).isVisible().catch(()=>false);
    const heading=await page.getByRole('heading').first().innerText();
    assert(history,`Created company ${c.id}; after reload screen is ${heading}; stored progress ${JSON.stringify(await progress(owner))}`);
    await page.getByRole('button',{name:/Seguir,/}).click();
    await page.waitForURL(/\/configuracion\/empresas/);
    const saved = (await progress(owner)).agregar;
    assert.equal(saved.companyId,c.id); assert.equal(saved.paso,'listo');
  });
  await record('Manual fallback preserves return destination',async()=>{
    page=await freshPage(owner,'/onboarding?from=empresas&returnTo=%2Fconfiguracion%2Fempresas');
    const link=page.getByRole('link',{name:'Conectar después',exact:true});await link.waitFor();
    const href=await link.getAttribute('href');
    await link.click();await page.waitForURL(/\/onboarding\/manual/);
    await screenshot('11-manual-return-context');
    assert(new URL(page.url()).searchParams.get('returnTo')==='/configuracion/empresas',`Fallback href ${href} loses from and returnTo; current URL ${page.url()}`);
    assert.equal(new URL(page.url()).searchParams.get('from'),'empresas');
  });
  await record('Connection recovers after a transient network failure',async()=>{
    const u=await newUser('offline',{paso:'fiel',companyId:null,perfil:'empresa',tono:'calma',tonoElegido:true});
    page=await freshPage(u);await mockFiel(page,{mode:'network-error'});await uploadSynthetic(page);
    await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).click();await pause(1200);
    const disabled=await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).isDisabled();
    const visibleError=await page.locator('.ob-err').count();
    await screenshot('12-network-failure');
    assert(!disabled&&visibleError>0,`After network abort: connect disabled=${disabled}, error messages=${visibleError}`);
    await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).click();
    await page.getByText('Confirma 2 datos',{exact:true}).waitFor();
    assert.equal(await page.getByPlaceholder('Contraseña de la llave privada',{exact:true}).inputValue(),'synthetic-only-password');
  });
  await record('Progress API rejects a different company',async()=>{
    const outsider=await newUser('outsider');const c=await newContext(outsider);
    const res=await c.request.patch(origin+'/api/onboarding/progreso',{data:{paso:'historial',companyId:company.id}});
    assert.equal(res.status(),404);await c.close();
  });
  await record('Concurrent profile and step saves preserve both fields',async()=>{
    const u=await newUser('race');const c=await newContext(u);const lost=[];
    for(let i=0;i<12;i++) {
      await prisma.user.update({where:{id:u.id},data:{onboarding:{paso:'hola',companyId:null,perfil:null,tono:'bal',tonoElegido:false}}});
      const rs=await Promise.all([
        c.request.patch(origin+'/api/onboarding/progreso',{data:{perfil:'empresa',tono:'calma'}}),
        c.request.patch(origin+'/api/onboarding/progreso',{data:{paso:'personaje'}}),
      ]);
      assert(rs.every(r=>r.ok()));
      const p=await progress(u);if(p.paso!=='personaje'||p.perfil!=='empresa'||p.tono!=='calma')lost.push({attempt:i+1,saved:p});
    }
    await c.close();
    assert.equal(lost.length,0,`Lost progress in ${lost.length}/12 pairs: ${JSON.stringify(lost)}`);
  });
  await record('Manual first-company flow validates fields and completes without credentials',async()=>{
    const u=await newUser('manual');page=await freshPage(u,'/onboarding/manual',true);
    await page.getByRole('button',{name:'Llénalo manualmente',exact:true}).click();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByText(/El RFC no tiene un formato válido/).waitFor();
    await page.locator('input[name=rfc]').fill(`SYC261001${tag.slice(-3).toUpperCase()}`);
    await page.locator('input[name=razonSocial]').fill(`SYNTHETIC ONBOARDING MANUAL ${tag}`);
    await page.locator('select[name=regimenFiscal]').selectOption('601');
    await page.locator('input[name=codigoPostal]').fill('06600');
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByRole('radio',{name:/No sincronizar ahora/}).check();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByRole('button',{name:/^Básico/}).click();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await screenshot('13-manual-credentials-mobile');
    const waiting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/companies'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Omitir',exact:true}).click();
    const res=await waiting;assert.equal(res.status(),201,await res.text());const co=await res.json();companies.push(co.id);
    await page.waitForURL(/\/dashboard/,{timeout:30000});
    const saved=await prisma.company.findUnique({where:{id:co.id}});assert.equal(saved.fielCer,null);assert.equal(saved.csdCer,null);assert.equal(saved.satBackfillYears,0);
    await screenshot('14-manual-complete-mobile');
    return {companyId:co.id,credentials:'none',providerResponses:'not mocked on this path'};
  });
  let invitationUser,firm;
  await record('Pending client invitation is visible in the new onboarding',async()=>{
    invitationUser=await newUser('pending-invitation');
    firm=await prisma.despacho.create({data:{name:`SYNTHETIC ONBOARDING FIRM ${tag}`}});despachos.push(firm.id);
    await prisma.company.update({where:{id:company.id},data:{despachoId:firm.id}});
    await prisma.companyInvitation.create({data:{companyId:company.id,despachoId:firm.id,invitedByUserId:owner.id,email:invitationUser.email,tokenHash:randomUUID().replaceAll('-','').repeat(2),expiresAt:new Date(Date.now()+86400000),role:'VIEWER'}});
    page=await freshPage(invitationUser);
    const api=await page.context().request.get(origin+'/api/invitations/pendientes');assert.equal(api.status(),200);assert.equal((await api.json()).length,1);
    await page.getByRole('heading',{name:'Hola. Yo te acompaño a dar de alta tu contabilidad.',exact:true}).waitFor();
    await pause(300);const newFlow=await page.getByText(/Te invitaron a/).count();await screenshot('15-pending-invite-new-flow');
    await page.goto(origin+'/onboarding/manual');await page.getByText(/Te invitaron a/).waitFor();await screenshot('16-pending-invite-manual');
    assert.equal(newFlow,1,'Valid pending invitation exists and manual flow displays it, but the new flow omits the invitation rescue');
  });
  await record('Existing firm access is counted by onboarding context',async()=>{
    const u=await newUser('firm-accountant');await prisma.despachoMember.create({data:{userId:u.id,despachoId:firm.id,role:'ACCOUNTANT'}});
    page=await freshPage(u);const c=page.context();
    const accessible=await (await c.request.get(origin+'/api/companies')).json();
    const ctx=await (await c.request.get(origin+'/api/onboarding/contexto')).json();
    assert(accessible.some(co=>co.id===company.id));
    await page.getByRole('heading').first().waitFor();await screenshot('17-firm-access-context');
    assert(ctx.empresas>=1,`Companies API returns ${accessible.length} accessible companies but onboarding context says empresas=${ctx.empresas}`);
  });
  await record('Incorrect key password gives a retryable error',async()=>{
    const u=await newUser('wrong-password',{paso:'fiel',companyId:null,perfil:'empresa',tono:'calma',tonoElegido:true});
    page=await freshPage(u);await mockFiel(page,{mode:'wrong-password'});await uploadSynthetic(page);
    await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).click();
    await page.locator('.ob-err').getByText('Contraseña incorrecta (simulada)',{exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'Conectar con el SAT',exact:true}).isEnabled());
    await screenshot('18-wrong-password-retry');return {providerValidation:'simulated'};
  });
  await record('Failed progress save stays visible and can be retried',async()=>{
    const u=await newUser('save-retry');page=await freshPage(u);
    let failed=false;
    await page.route('**/api/onboarding/progreso',route=>{
      if(route.request().method()==='PATCH'&&!failed){failed=true;return route.abort('failed');}
      return route.fallback();
    });
    await page.getByRole('button',{name:/Es mi empresa/}).click();
    await page.getByRole('button',{name:'Reintentar guardado',exact:true}).waitFor();
    assert.equal((await progress(u))?.perfil??null,null);
    await screenshot('19-progress-save-retry');
    await page.getByRole('button',{name:'Reintentar guardado',exact:true}).click();
    await page.getByRole('heading',{name:'Elige cómo quieres que me vea',exact:true}).waitFor();
    const saved=await progress(u);assert.equal(saved.perfil,'empresa');assert.equal(saved.paso,'personaje');
  });
  await record('Manual add-company completion retries without creating a duplicate',async()=>{
    page=await freshPage(owner,'/onboarding/manual?from=empresas&returnTo=%2Fconfiguracion%2Fempresas');
    await page.getByRole('button',{name:'Llénalo manualmente',exact:true}).click();
    const rfc=`SYD261001${tag.slice(-3).toUpperCase()}`;
    await page.locator('input[name=rfc]').fill(rfc);
    await page.locator('input[name=razonSocial]').fill(`SYNTHETIC RETRY ${tag}`);
    await page.locator('select[name=regimenFiscal]').selectOption('601');
    await page.locator('input[name=codigoPostal]').fill('06600');
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByRole('radio',{name:/No sincronizar ahora/}).check();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    let failed=false,creates=0;
    await page.route('**/api/onboarding/progreso',route=>{
      if(route.request().method()==='PATCH'&&!failed){failed=true;return route.abort('failed');}
      return route.fallback();
    });
    await page.route('**/api/companies',route=>{
      if(route.request().method()==='POST')creates++;
      return route.fallback();
    });
    const waiting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/companies'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Omitir',exact:true}).click();
    const res=await waiting;assert.equal(res.status(),201,await res.text());const co=await res.json();companies.push(co.id);
    await page.getByText('Se interrumpió la conexión. Revisa tu conexión e intenta de nuevo.',{exact:true}).waitFor();
    await screenshot('20-manual-completion-retry');
    await page.getByRole('button',{name:'Omitir',exact:true}).click();
    await page.waitForURL(/\/configuracion\/empresas/);
    assert.equal(creates,1);assert.equal(await prisma.company.count({where:{rfc}}),1);
    const saved=(await progress(owner)).agregar;
    assert.equal(saved.companyId,co.id);assert.equal(saved.paso,'listo');
  });
  assert.deepEqual(allErrors, [], 'No uncaught browser exceptions, including simulated failures');
} finally {
  await browser?.close();
  if(companies.length){
    await prisma.auditLog.deleteMany({where:{companyId:{in:companies}}});
    await prisma.company.deleteMany({where:{id:{in:companies}}});
  }
  if(despachos.length) await prisma.despacho.deleteMany({where:{id:{in:despachos}}});
  if(users.length) await prisma.user.deleteMany({where:{id:{in:users}}});
  await prisma.$disconnect();
  await writeFile(out+'results.json',JSON.stringify({tag,results,allErrors,screenshots,cleaned:true},null,2));
}
console.log(JSON.stringify(results,null,2));

process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
