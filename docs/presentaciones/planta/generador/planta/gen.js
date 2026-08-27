const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "html");
fs.mkdirSync(OUT, { recursive: true });

const P = {
  home:'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22V12h6v10',
  drop:'M12 2.7l5.66 5.66a8 8 0 1 1-11.32 0z',
  pkg:'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z|M3.3 7L12 12l8.7-5|M12 22V12',
  truck:'RECT1,3,15,13,1|M16 8h4l3 3v5h-7V8z|CIRC5.5,18.5,2.5|CIRC18.5,18.5,2.5',
  gob:'M3 22h18|M6 18v-7|M10 18v-7|M14 18v-7|M18 18v-7|M12 2L3 7h18z',
  users:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|CIRC9,7,4|M23 21v-2a4 4 0 0 0-3-3.87',
  cart:'CIRC9,21,1|CIRC20,21,1|M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6',
  shield:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  card:'RECT1,4,22,16,2|M1 10h22',
  clip:'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2|RECT8,2,8,4,1',
  chart:'M18 20V10|M12 20V4|M6 20v-4',
  slid:'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6',
  search:'CIRC11,11,8|M21 21l-4.35-4.35', bell:'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9|M13.7 21a2 2 0 0 1-3.4 0',
  chk:'M22 11.08V12a10 10 0 1 1-5.93-9.14|M22 4L12 14.01l-3-3',
  alert:'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4|M12 17h.01',
  plus:'M12 5v14|M5 12h14', clock:'CIRC12,12,10|M12 6v6l4 2',
  file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6',
  refresh:'M23 4v6h-6|M1 20v-6h6|M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  arrowdown:'M12 5v14|M19 12l-7 7-7-7', arrowup:'M12 19V5|M5 12l7-7 7 7',
  lock:'RECT3,11,18,11,2|M7 11V7a5 5 0 0 1 10 0v4',
};
const ic = (n, cls = "") => {
  const parts = (P[n] || "").split("|").map(d =>
    d.startsWith("RECT") ? (([x,y,w,h,r]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`)(d.slice(4).split(","))
    : d.startsWith("CIRC") ? (([cx,cy,r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`)(d.slice(4).split(","))
    : `<path d="${d}"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 24 24">${parts}</svg>`;
};

const NAV = [["home","Inicio"],["drop","Producción"],["pkg","Envases"],["truck","Reparto"],["gob","Gobierno"],
             ["users","Clientes"],["cart","Compras"],["shield","Normativ."],["card","Bancos"],
             ["clip","Nómina"],["chart","Reportes"],["slid","Config."]];

const rail = (active) => `<div class="rail"><div class="logo">${ic("drop")}</div>` +
  NAV.map(([k, l]) => `<div class="ri ${k === active ? "on" : ""}">${ic(k)}<span class="lbl">${l}</span></div>`).join("") + `</div>`;

const top = (title, crumb, right = "") => `<div class="top"><h1>${title}</h1>${crumb ? `<span class="crumb">${crumb}</span>` : ""}
  <div class="spacer"></div>${right}
  <div class="search">${ic("search")}<span>Buscar remisión, contrato o cliente…</span></div>
  <div class="bell">${ic("bell")}<b>3</b></div><div class="avatar">GR</div></div>`;

const page = (name, active, title, crumb, body, right = "") => {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="../base.css">
<style>.logo svg{width:22px;height:22px;stroke:#fff}</style></head><body>${rail(active)}
<div class="main">${top(title, crumb, right)}<div class="body">${body}</div></div></body></html>`;
  fs.writeFileSync(path.join(OUT, name + ".html"), html);
};
const money = (n) => "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => n.toLocaleString("es-MX");

/* ── 1 · Tablero ────────────────────────────────────────────────────────── */
page("tablero", "home", "Buenos días", "Lunes 24 de agosto, 2026", `
<div class="tiles" style="grid-template-columns:repeat(4,1fr)">
  ${[["Producción de hoy","980","garrafones · 19,530 L embotellados"],
     ["Garrafones fuera","1,240","en 14 clientes · $93,000 en reposición"],
     ["Cartera de gobierno","$260,450","$67,200 vencido — 1 dependencia"],
     ["Rendimiento del mes","97.2%","merma 2.8% · meta ≤ 3%"]]
    .map(([k,v,d])=>`<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`).join("")}
</div>
<div style="display:grid;grid-template-columns:1.55fr 1fr;gap:16px;flex:1;min-height:0">
  <div class="card" style="display:flex;flex-direction:column">
    <div class="ch"><h2>Movimiento del día</h2><span class="sub">pipas, producción y remisiones</span><div class="spacer"></div><span class="chip p">En vivo</span></div>
    <table><thead><tr><th>Hora</th><th>Evento</th><th>Detalle</th><th class="r">Cantidad</th><th>Estado</th></tr></thead><tbody>
    ${[["07:40","Pipa recibida","Pipas del Valle · P-0847","20,000 L","Descargada","j"],
       ["08:00","Turno matutino inicia","Lote L-0824-M · Op. J. Carrillo","—","En curso","p"],
       ["09:15","Remisión R-1041","DIF Municipal · Comedor Centro","120 gfn.","Entregada","j"],
       ["11:20","Remisión R-1042","Secretaría de Salud · Almacén Central","400 gfn.","Entregada","j"],
       ["12:05","Retorno de vacíos","R-1042 · mismo viaje","380 gfn.","Registrado","j"],
       ["13:30","Remisión R-1043","Hospital General de Zona","160 gfn.","En ruta","a"],
       ["14:00","Cloro residual","Bitácora · 1.1 ppm (rango 0.2–1.5)","—","Dentro de norma","j"],
       ["15:10","Lavado de garrafones","Retornos de la mañana","505 gfn.","En curso","p"]]
      .map(([h,e,d,c,s,cc])=>`<tr><td class="num soft sm">${h}</td><td class="b">${e}</td><td class="soft sm">${d}</td>
        <td class="r num b">${c}</td><td><span class="chip ${cc}">${s}</span></td></tr>`).join("")}
    </tbody></table>
  </div>
  <div class="card" style="display:flex;flex-direction:column">
    <div class="ch"><h2>Requiere atención</h2><div class="spacer"></div><span class="chip c">4</span></div>
    <div style="padding:6px 0">
    ${[["alert","r","Factura HGZ vencida hace 7 días","$67,200 · contrato a 45 días · llamar a pagos"],
       ["pkg","a","Saldo de envases de HGZ crece 3 semanas","+210 garrafones sin retornar"],
       ["shield","a","Análisis de metales pesados vence en 13 días","Programar muestreo con el laboratorio"],
       ["refresh","a","Filtro de carbón activado: cambio en 12 días","Última recarga 26 may · pedir a proveedor"],
       ["file","p","Remisión R-1039 sin facturar","IEE · incluirla en el corte de agosto"],
       ["clock","","Complemento de pago pendiente","DIF pagó el 21 ago · emitir REP antes del 5 sep"]]
      .map(([i,t,h,s])=>`<div style="display:flex;gap:11px;padding:12px 20px;border-bottom:1px solid var(--line-soft)">
        <div class="chip ${t}" style="width:28px;height:28px;padding:0;justify-content:center;border-radius:9px">${ic(i)}</div>
        <div><div class="b sm">${h}</div><div class="muted sm" style="margin-top:2px">${s}</div></div></div>`).join("")}
    </div>
  </div>
</div>`, `<div class="btn ghost">${ic("plus")}Recibir pipa</div><div class="btn">${ic("plus")}Nueva remisión</div>`);

/* ── 2 · Producción — espejo de la máquina ──────────────────────────────── */
const tank = (label, pct, sub) => `
  <div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:150px">
    <div style="width:92px;height:128px;border:2px solid var(--purple-mid);border-radius:12px;position:relative;overflow:hidden;background:var(--card)">
      <div style="position:absolute;left:0;right:0;bottom:0;height:${pct}%;background:linear-gradient(180deg,#7FD4EA,#0E93B8)"></div>
      <div style="position:absolute;inset:0;display:grid;place-items:center;font-weight:700;font-size:17px;color:var(--ink)" class="num">${pct}%</div>
    </div>
    <div class="b sm" style="text-align:center">${label}</div>
    <div class="muted" style="font-size:11px;text-align:center;margin-top:-4px">${sub}</div>
  </div>`;
const flow = () => `<div style="flex:1;height:2px;background:var(--purple-mid);position:relative;min-width:34px">
  <div style="position:absolute;right:-1px;top:-4px;border:5px solid transparent;border-left:7px solid var(--purple-mid)"></div></div>`;
page("produccion", "drop", "Producción", "Lote L-0824-M · turno matutino · Op. J. Carrillo", `
<div style="display:grid;grid-template-columns:1fr 330px;gap:16px;flex:1;min-height:0">
 <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
  <div class="card" style="flex:1;display:flex;flex-direction:column">
    <div class="ch"><h2>La máquina, en vivo</h2><span class="sub">el mismo diagrama que ves en la PORTAQUA</span>
      <div class="spacer"></div><span class="chip j">${ic("chk")} Operando</span></div>
    <div style="flex:1;display:flex;align-items:center;padding:10px 34px;gap:10px">
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:130px">
        <div style="width:74px;height:74px;border-radius:50%;border:2px solid var(--purple-mid);display:grid;place-items:center;color:var(--purple)">${ic("drop","")}</div>
        <div class="b sm" style="text-align:center">Bomba agua cruda</div>
        <div class="muted" style="font-size:11px;margin-top:-4px">pipa P-0847</div>
      </div>
      ${flow()}
      ${tank("Tanque agua clorada",62,"cloro 1.2 ppm · 08:00")}
      ${flow()}
      ${tank("Tanque agua purificada",78,"conductividad OK")}
      ${flow()}
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:110px">
        <div style="width:74px;height:74px;border-radius:50%;border:2px solid var(--purple-mid);display:grid;place-items:center;color:var(--purple)">${ic("chk")}</div>
        <div class="b sm" style="text-align:center">Sellado</div>
        <div class="muted" style="font-size:11px;margin-top:-4px">termoencogido</div>
      </div>
      ${flow()}
      <div style="display:flex;flex-direction:column;gap:10px;width:190px">
        ${[["Boquilla izquierda","20 L","512"],["Boquilla derecha","19/20 L","468"]]
          .map(([b,f,c])=>`<div class="card" style="padding:12px 14px;box-shadow:none">
          <div style="display:flex;align-items:baseline"><span class="b sm">${b}</span><div class="spacer"></div>
          <span class="chip p" style="font-size:10px">${f}</span></div>
          <div class="num" style="font-size:24px;font-weight:700;margin-top:4px">${c}<span class="muted" style="font-size:11px;font-weight:400"> llenados</span></div></div>`).join("")}
      </div>
    </div>
    <div style="display:flex;gap:26px;padding:14px 34px;border-top:1px solid var(--line-soft)">
      ${[["Contador del turno","980","garrafones (HMI)"],["Litros embotellados","19,530","910×20L + 70×19L"],
         ["Merma","470 L","2.35% del lote"],["Rendimiento","97.6%","meta ≥ 97%"]]
        .map(([k,v,s])=>`<div><div class="muted" style="font-size:11px">${k}</div>
        <div class="num" style="font-size:21px;font-weight:700;letter-spacing:-.5px">${v}</div>
        <div class="muted" style="font-size:11px">${s}</div></div>`).join("")}
      <div class="spacer"></div>
      <div class="btn" style="align-self:center">Cerrar turno</div>
    </div>
  </div>
  <div class="card">
    <div class="ch"><h2>Pipas recibidas hoy</h2></div>
    <table><thead><tr><th>Folio</th><th>Proveedor</th><th class="r">Litros</th><th class="r">Costo</th><th class="r">$/L</th><th>CFDI</th></tr></thead><tbody>
    <tr><td class="num b">P-0847</td><td>Pipas del Valle</td><td class="r num b">20,000</td><td class="r num">$2,600.00</td>
        <td class="r num">$0.130</td><td><span class="chip j">Recibido</span></td></tr>
    <tr><td class="num b">P-0846</td><td>Agua Industrial Puebla</td><td class="r num b">10,000</td><td class="r num">$1,380.00</td>
        <td class="r num">$0.138</td><td><span class="chip a">Por recibir</span></td></tr>
    </tbody></table>
  </div>
 </div>
 <div style="display:flex;flex-direction:column;gap:14px">
  <div class="card pad" style="background:var(--purple);border:none;color:#fff">
    <div style="font-size:11.5px;opacity:.82">El número que hoy nadie tiene</div>
    <div style="font-size:15px;font-weight:700;line-height:1.4;margin-top:6px">Litros que entraron vs. litros que salieron — y dónde quedó la diferencia.</div>
    <div style="font-size:11.5px;opacity:.82;margin-top:8px">El contador de la máquina se captura al cerrar el turno y el sistema cuadra solo.</div>
  </div>
  <div class="card" style="flex:1">
    <div class="ch"><h2>Últimos lotes</h2></div>
    <table><thead><tr><th>Lote</th><th class="r">Llenados</th><th class="r">Rend.</th></tr></thead><tbody>
    ${[["L-0823-V",760,"97.1%"],["L-0823-M",1010,"97.8%"],["L-0822-V",690,"96.4%"],["L-0822-M",985,"97.5%"],["L-0821-M",940,"97.9%"],["L-0820-V",720,"96.9%"],["L-0820-M",1005,"97.4%"],["L-0819-M",930,"97.2%"]]
      .map(([l,c,r])=>`<tr><td class="num b">${l}</td><td class="r num">${num(c)}</td><td class="r num">${r}</td></tr>`).join("")}
    </tbody></table>
  </div>
 </div>
</div>`);
console.log("planta gen 1: tablero, produccion");

/* ── 3 · Envases en comodato ────────────────────────────────────────────── */
page("envases", "pkg", "Envases en comodato", "Saldo de garrafones por cliente", `
<div class="tiles" style="grid-template-columns:repeat(4,1fr)">
  ${[["Garrafones fuera","1,240","en 14 clientes"],["Valor en reposición","$93,000","a $75 por garrafón"],
     ["Retornaron esta semana","1,860","de 1,905 entregados"],["Bajas por rotura (mes)","23","0.4% del parque"]]
    .map(([k,v,d])=>`<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`).join("")}
</div>
<div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden">
  <div class="ch"><h2>Saldo por cliente</h2><span class="sub">salieron llenos − regresaron vacíos, remisión por remisión</span>
    <div class="spacer"></div><span class="chip a">${ic("alert")} 2 saldos creciendo</span><div class="btn ghost">Kardex de envases</div></div>
  <table><thead><tr><th>Cliente</th><th>Contrato</th><th class="r">Salieron (mes)</th><th class="r">Regresaron</th>
    <th class="r">Saldo actual</th><th>Tendencia 4 sem.</th><th>Estado</th></tr></thead><tbody>
  ${[["Secretaría de Salud del Estado","SS-2026-114",8400,8180,340,[300,310,320,340],"a","Creciendo"],
     ["Hospital General de Zona","HGZ-2026-077",3120,2980,210,[150,170,190,210],"a","Creciendo 3 sem."],
     ["DIF Municipal","DIF-2026-031",2460,2440,85,[90,88,86,85],"","Estable"],
     ["Instituto Estatal de Educación","IEE-2026-090",1240,1235,55,[60,58,56,55],"","Estable"],
     ["Comedor Comunitario Norte","—",180,178,12,[14,13,12,12],"","Estable"],
     ["Abarrotes La Cascada","—",96,96,4,[6,5,4,4],"j","Al día"],
     ["Constructora GARSA","—",310,305,28,[30,29,28,28],"","Estable"],
     ["Restaurante El Mirador","—",140,138,9,[10,10,9,9],"","Estable"],
     ["Colegio Cumbres de Puebla","—",420,416,32,[35,34,33,32],"","Estable"],
     ["Notaría Pública 18","—",44,44,2,[3,2,2,2],"j","Al día"]]
    .map(([c,k,s,r,saldo,trend,cc,est])=>{
      const max=Math.max(...trend), min=Math.min(...trend);
      const bars=trend.map(v=>`<div style="width:9px;height:${8+Math.round((v-min)/((max-min)||1)*20)}px;border-radius:2px;
        background:${cc==="a"?"var(--amber)":"var(--purple-mid)"}"></div>`).join("");
      return `<tr style="${cc==="a"?"background:var(--amber-tint)":""}">
      <td class="b">${c}</td><td class="num soft sm">${k}</td>
      <td class="r num">${num(s)}</td><td class="r num">${num(r)}</td>
      <td class="r num b" style="font-size:14px">${saldo}</td>
      <td><div style="display:flex;gap:3px;align-items:flex-end;height:28px">${bars}</div></td>
      <td><span class="chip ${cc}">${est}</span></td></tr>`}).join("")}
  </tbody></table>
  <div style="padding:12px 20px;border-top:1px solid var(--line)" class="muted sm">
    El saldo nunca se teclea: se deriva de las remisiones. Un garrafón que no regresa aparece aquí — con cliente, fecha y número.</div>
</div>`);

/* ── 4 · Gobierno: contratos ────────────────────────────────────────────── */
page("gobierno", "gob", "Contratos con gobierno", "Vigencias, precios pactados y consumo contra tope", `
<div class="tiles" style="grid-template-columns:repeat(4,1fr)">
  ${[["Contratos vigentes","4","2 vencen este año"],["Facturado 2026","$1,224,600","IVA 0% · Art. 2-A LIVA"],
     ["Cartera viva","$260,450","$67,200 vencido"],["Complementos pendientes","2","REP antes del 5 sep"]]
    .map(([k,v,d])=>`<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`).join("")}
</div>
<div class="card" style="display:flex;flex-direction:column;overflow:hidden">
  <div class="ch"><h2>Contratos</h2><div class="spacer"></div><div class="btn">${ic("plus")}Nuevo contrato</div></div>
  <table><thead><tr><th>Contrato</th><th>Dependencia</th><th class="r">Precio/gfn.</th><th>Vigencia</th>
    <th style="width:250px">Consumido contra tope</th><th class="r">Días de pago</th></tr></thead><tbody>
  ${[["SS-2026-114","Secretaría de Salud del Estado",14.50,"01 mar 26 – 28 feb 27",742000,1800000,45,""],
     ["HGZ-2026-077","Hospital General de Zona",14.00,"01 ene 26 – 31 dic 26",289800,420000,45,"a"],
     ["DIF-2026-031","DIF Municipal",15.00,"01 ene 26 – 31 dic 26",261450,600000,30,""],
     ["IEE-2026-090","Instituto Estatal de Educación",15.25,"15 may 26 – 14 may 27",96400,380000,30,""]]
    .map(([k,d,p,v,cons,tope,dias,warn])=>{
      const pct=Math.round(cons/tope*100);
      return `<tr><td class="num b">${k}</td><td class="b">${d}</td><td class="r num">${money(p)}</td>
      <td class="soft sm">${v}</td>
      <td><div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;height:8px;border-radius:4px;background:var(--paper);overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${pct>66?"var(--amber)":"var(--coral)"}"></div></div>
        <span class="num sm b" style="width:88px">${pct}% · ${money(cons/1000)}k</span></div></td>
      <td class="r num ${warn?"b":""}">${dias}${warn?` <span class="chip a" style="margin-left:4px">excedido</span>`:""}</td></tr>`}).join("")}
  </tbody></table>
  <div style="padding:12px 20px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center">
    <span class="muted sm">El tope del contrato HGZ se alcanza en ~9 semanas al ritmo actual — tiempo de gestionar la ampliación, no de descubrirlo.</span>
    <div class="spacer"></div><span class="chip a">${ic("alert")} HGZ al 69% del tope</span></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1.25fr;gap:16px;flex:1;min-height:0">
  <div class="card" style="overflow:hidden">
    <div class="ch"><h2>Trámites en curso</h2></div>
    ${[["Ampliación de tope · HGZ-2026-077","Oficio enviado 19 ago · en firma de la dirección","a","En trámite"],
       ["Renovación · DIF-2026-031","Vence 31 dic · propuesta entregada","p","Propuesta"],
       ["Licitación LA-21-2026","Junta de aclaraciones: 4 sep","p","Por concursar"]]
      .map(([t,s,cc,est])=>`<div style="display:flex;gap:11px;padding:12px 20px;border-bottom:1px solid var(--line-soft);align-items:center">
        <div style="min-width:0"><div class="b sm">${t}</div><div class="muted sm" style="margin-top:2px">${s}</div></div>
        <div class="spacer"></div><span class="chip ${cc}">${est}</span></div>`).join("")}
  </div>
  <div class="card" style="display:flex;flex-direction:column">
    <div class="ch"><h2>Facturado a gobierno por mes</h2><span class="sub">2026 · miles de pesos</span></div>
    <div class="pad" style="flex:1;display:flex;align-items:flex-end;gap:14px;padding-bottom:14px">
      ${[["ene",118],["feb",124],["mar",139],["abr",151],["may",148],["jun",162],["jul",158],["ago",174]]
        .map(([m,v])=>`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px">
          <div class="num sm b">${v}</div>
          <div style="width:100%;height:${Math.round(v/174*96)}px;background:${m==="ago"?"var(--coral)":"var(--purple-mid)"};border-radius:7px 7px 0 0"></div>
          <div class="muted" style="font-size:11px">${m}</div></div>`).join("")}
    </div>
  </div>
</div>`);

/* ── 5 · Cartera por dependencia ────────────────────────────────────────── */
page("cartera", "gob", "Cartera de gobierno", "Remitido → facturado → cobrado, por dependencia", `
<div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden">
  <div class="ch"><h2>Agosto 2026</h2><span class="sub">cada peso en una de tres columnas — sin doble conteo</span>
    <div class="spacer"></div><span class="chip r">1 factura vencida</span></div>
  <table><thead><tr><th>Dependencia</th><th class="r">Remitido sin facturar</th><th class="r">Facturado por cobrar</th>
    <th class="r">Cobrado (mes)</th><th class="r">Días transcurridos</th><th>Estado</th></tr></thead><tbody>
  ${[["Secretaría de Salud del Estado",5800,121800,118400,"32 de 45","","En plazo"],
     ["Hospital General de Zona",0,67200,64100,"52 de 45","r","Vencida 7 días"],
     ["DIF Municipal",1800,48300,51200,"18 de 30","","En plazo"],
     ["Instituto Estatal de Educación",3050,23150,19800,"9 de 30","","En plazo"]]
    .map(([d,rem,fact,cob,dias,cc,est])=>`<tr style="${cc==="r"?"background:var(--red-tint)":""}">
      <td class="b">${d}</td><td class="r num">${rem?money(rem):"—"}</td>
      <td class="r num b">${money(fact)}</td><td class="r num soft">${money(cob)}</td>
      <td class="r num ${cc?"b":""}">${dias}</td><td><span class="chip ${cc}">${est}</span></td></tr>`).join("")}
  <tr style="background:var(--paper)"><td class="b">Total</td><td class="r num b">$10,650.00</td>
    <td class="r num b" style="font-size:14px">$260,450.00</td><td class="r num b">$253,500.00</td><td></td><td></td></tr>
  </tbody></table>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:16px 20px;border-top:1px solid var(--line-soft)">
    <div class="card pad" style="box-shadow:none">
      <div class="b sm" style="margin-bottom:8px">Qué sigue con HGZ</div>
      <div class="soft sm" style="line-height:1.5">Factura F-2214 venció el 17 ago. El contrato prevé intereses moratorios;
      el oficio de requerimiento sale de aquí con un clic, con la remisión sellada anexa.</div></div>
    <div class="card pad" style="box-shadow:none">
      <div class="b sm" style="margin-bottom:8px">Complementos de pago</div>
      <div class="soft sm" style="line-height:1.5">DIF pagó el 21 ago ($51,200). El REP se emite antes del 5 de septiembre —
      el sistema lo tiene en la lista y avisa solo.</div></div>
  </div>
</div>`);
console.log("planta gen 2: envases, gobierno, cartera");

/* ── 6 · Normatividad ───────────────────────────────────────────────────── */
page("normatividad", "shield", "Normatividad", "NOM-201-SSA1 · bitácoras y análisis al día", `
<div style="display:grid;grid-template-columns:1.25fr 1fr;gap:16px;flex:1;min-height:0">
 <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
  <div class="card" style="flex:1;display:flex;flex-direction:column">
    <div class="ch"><h2>Bitácora sanitaria — hoy</h2><div class="spacer"></div>
      <span class="chip j">${ic("chk")} Dentro de norma</span><div class="btn">${ic("plus")}Registrar</div></div>
    <table><thead><tr><th>Hora</th><th>Registro</th><th class="r">Valor</th><th>Rango NOM</th><th>Responsable</th></tr></thead><tbody>
    ${[["08:00","Cloro residual libre","1.2 ppm","0.2 – 1.5 ppm","J. Carrillo","j"],
       ["08:10","Lavado y sanitizado de boquillas","OK","diario","J. Carrillo","j"],
       ["11:00","Sólidos disueltos (TDS)","28 ppm","≤ 500 ppm","J. Carrillo","j"],
       ["14:00","Cloro residual libre","1.1 ppm","0.2 – 1.5 ppm","R. Estrada","j"],
       ["15:30","Lavado de garrafones (lote retorno)","505 pzas","registro por lote","R. Estrada","j"]]
      .map(([h,r,v,n,resp,cc])=>`<tr><td class="num soft sm">${h}</td><td class="b">${r}</td>
      <td class="r num b">${v}</td><td class="soft sm">${n}</td><td class="soft sm">${resp}</td></tr>`).join("")}
    </tbody></table>
    <div style="padding:11px 20px;border-top:1px solid var(--line-soft)" class="muted sm">
      Lavado de tanques: sábado 22 ago · próxima fumigación: 02 nov · todo con responsable y hora, sin cuadernos.</div>
  </div>
 </div>
 <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
  <div class="card" style="flex:1;display:flex;flex-direction:column">
    <div class="ch"><h2>Análisis y vigencias</h2><div class="spacer"></div><span class="chip a">1 por vencer</span></div>
    <div style="padding:4px 0">
    ${[["Microbiológico","Lab. Certimex · 15 jul 2026","Vigente hasta 15 oct","j",""],
       ["Fisicoquímico","Lab. Certimex · 28 may 2026","Vigente hasta 28 nov","j",""],
       ["Metales pesados","Lab. AquaCheck · 8 mar 2026","Vence 8 sep — en 13 días","a","Programar muestreo"],
       ["Aviso de funcionamiento","COFEPRIS · folio 21-330-26","Permanente · PDF en expediente","",""]]
      .map(([t,l,v,cc,acc])=>`<div style="display:flex;gap:11px;padding:12px 18px;border-bottom:1px solid var(--line-soft)">
        <div class="chip ${cc}" style="width:28px;height:28px;padding:0;justify-content:center;border-radius:9px">${ic(cc==="a"?"alert":"file")}</div>
        <div style="min-width:0"><div class="b sm">${t}</div><div class="muted sm" style="margin-top:2px">${l}</div>
        <div style="margin-top:5px"><span class="chip ${cc}">${v}</span>${acc?` <span class="chip" style="margin-left:4px">${acc}</span>`:""}</div></div>
        <div class="spacer"></div><span class="muted sm" style="align-self:center">PDF</span></div>`).join("")}
    </div>
  </div>
  <div class="card pad">
    <div class="b sm" style="margin-bottom:7px;display:flex;align-items:center;gap:7px">${ic("refresh")} Mantenimiento de equipo</div>
    ${[["Filtro de carbón activado","cambio en 12 días","a"],["Lámpara UV","3,120 de 8,000 h",""],["Membranas / cartuchos","cambiados 26 may","j"]]
      .map(([t,s,cc])=>`<div style="display:flex;align-items:center;padding:6px 0"><span class="sm">${t}</span>
      <div class="spacer"></div><span class="chip ${cc}">${s}</span></div>`).join("")}
  </div>
 </div>
</div>`);

/* ── 7 · Estado de cuenta + CFDI ────────────────────────────────────────── */
page("estadocuenta", "gob", "Estado de cuenta", "Secretaría de Salud del Estado · agosto 2026", `
<div style="display:grid;grid-template-columns:1fr 340px;gap:16px;flex:1;min-height:0">
  <div class="card" style="display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:24px 34px 16px;border-bottom:1px solid var(--line-soft);display:flex;align-items:flex-start">
      <div><div style="font-size:21px;font-weight:700;letter-spacing:-.5px">Estado de cuenta — agosto 2026</div>
        <div class="muted sm" style="margin-top:5px">Secretaría de Salud del Estado · contrato SS-2026-114 · $14.50 por garrafón · IVA 0%</div></div>
      <div class="spacer"></div><span class="chip j">${ic("chk")} Cuadra con remisiones</span></div>
    <table style="margin:0 20px"><thead><tr><th>Punto de entrega</th><th class="r">Remisiones</th>
      <th class="r">Garrafones</th><th class="r">Vacíos devueltos</th><th class="r">Importe</th></tr></thead><tbody>
    ${[["Almacén Central",9,4200,4090,60900],["Hospital del Niño Poblano",6,2300,2260,33350],
       ["Centro de Salud Oriente",5,1300,1270,18850],["Oficinas centrales",3,600,560,8700]]
      .map(([s,r,g,v,i])=>`<tr><td class="b">${s}</td><td class="r num">${r}</td><td class="r num b">${num(g)}</td>
      <td class="r num soft">${num(v)}</td><td class="r num b">${money(i)}</td></tr>`).join("")}
    <tr style="background:var(--paper)"><td class="b">Total del mes</td><td class="r num b">23</td>
      <td class="r num b">8,400</td><td class="r num b">8,180</td><td class="r num b" style="font-size:15px">$121,800.00</td></tr>
    </tbody></table>
    <div style="padding:14px 34px;margin-top:auto;border-top:1px solid var(--line);display:flex;align-items:center">
      <div class="muted sm" style="max-width:430px;line-height:1.5">Cada renglón trae sus remisiones selladas anexas —
        el soporte que la dependencia pide antes de pagar, listo en PDF.</div>
      <div class="spacer"></div>
      <div class="btn ghost">Descargar PDF</div><div class="btn" style="margin-left:8px">Timbrar CFDI</div></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="card pad" style="background:var(--purple);border:none;color:#fff">
      <div style="font-size:11.5px;opacity:.82">CFDI del mes</div>
      <div class="num" style="font-size:27px;font-weight:700;letter-spacing:-1px;margin:5px 0 3px">$121,800.00</div>
      <div style="font-size:11.5px;opacity:.85;line-height:1.5">PPD · pago a 45 días<br>IVA 0% — agua en envase mayor a 10 L (Art. 2-A LIVA)</div>
    </div>
    <div class="card">
      <div class="ch"><h2>Trazabilidad</h2><span class="sub">del sello al libro</span></div>
      <div class="pad" style="display:flex;flex-direction:column">
      ${[["23 remisiones selladas","cada una con vacíos recogidos",1],["Estado de cuenta","cuadra al garrafón",1],
         ["CFDI PPD timbrado","consolidado del mes",1],["Cobro y complemento","REP al recibir el pago",0],
         ["Póliza contable","se genera sola",0]]
        .map(([t,s,d],i,arr)=>`<div style="display:flex;gap:11px">
          <div style="display:flex;flex-direction:column;align-items:center;flex:none">
            <div style="width:19px;height:19px;border-radius:50%;display:grid;place-items:center;
              ${d?"background:var(--jade)":"background:var(--purple-tint);border:1.5px solid var(--purple-mid)"}">
              ${d?`<svg viewBox="0 0 24 24" style="width:11px;height:11px;stroke:#fff;fill:none;stroke-width:4;stroke-linecap:round"><path d="M20 6L9 17l-5-5"/></svg>`:""}</div>
            ${i<arr.length-1?`<div style="width:2px;flex:1;background:var(--line);min-height:15px"></div>`:""}</div>
          <div style="padding-bottom:${i<arr.length-1?"9px":"0"}"><div class="b sm">${t}</div>
          <div class="muted" style="font-size:11px;margin-top:1px">${s}</div></div></div>`).join("")}
      </div>
    </div>
  </div>
</div>`);
console.log("planta gen 3: normatividad, estadocuenta");

/* ── 8 · Remisión (móvil del chofer) ────────────────────────────────────── */
const phone = (inner) => `<div style="width:340px;height:700px;background:#fff;border-radius:34px;overflow:hidden;
  box-shadow:0 30px 70px -20px rgba(4,30,45,.6);display:flex;flex-direction:column;flex:none">
  <div style="height:34px;background:var(--purple);display:flex;align-items:center;padding:0 20px;color:#fff;font-size:11px;font-weight:700">
    <span class="num">11:20</span><div class="spacer"></div><span class="num">88%</span></div>${inner}</div>`;
const mobilePage = (name, kicker, title, lead, inner) => {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><link rel="stylesheet" href="../base.css">
  </head><body style="width:1600px;height:920px;background:var(--purple);display:flex;align-items:center;justify-content:center;gap:78px;padding:0 110px">
  <div style="max-width:520px;color:#fff">
    <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#7FD4EA;margin-bottom:16px">${kicker}</div>
    <div style="font-size:38px;font-weight:700;letter-spacing:-1.2px;line-height:1.15;margin-bottom:18px">${title}</div>
    <div style="font-size:16.5px;line-height:1.6;opacity:.88">${lead}</div>
  </div>${phone(inner)}</body></html>`;
  fs.writeFileSync(path.join(OUT, name + ".html"), html);
};

mobilePage("remision", "LA REMISIÓN, DESDE EL CAMIÓN",
  "El talón sellado deja de vivir en una carpeta",
  "El chofer entrega llenos, recoge vacíos y registra quién recibió — en el mismo viaje y desde su teléfono. El saldo de garrafones de la dependencia se actualiza solo.",
  `<div style="padding:18px 20px 14px;background:var(--purple);color:#fff">
     <div style="display:flex;align-items:center"><div>
       <div style="font-size:17px;font-weight:700">Remisión R-1042</div>
       <div style="font-size:11px;opacity:.8;margin-top:2px">Secretaría de Salud · Almacén Central</div></div>
       <div class="spacer"></div><span class="chip" style="background:rgba(255,255,255,.16);color:#fff">SS-2026-114</span></div></div>
   <div style="flex:1;background:var(--canvas);padding:14px 16px;overflow:hidden">
     <div class="card pad" style="margin-bottom:12px;padding:14px 16px">
       <div class="muted" style="font-size:11px;margin-bottom:8px">ENTREGA</div>
       <div style="display:flex;align-items:center;gap:12px">
         <div style="flex:1;text-align:center;background:var(--purple-tint);border-radius:12px;padding:12px 0">
           <div class="num" style="font-size:30px;font-weight:700;color:var(--purple)">400</div>
           <div class="muted" style="font-size:11px">llenos entregados</div></div>
         <div style="flex:1;text-align:center;background:var(--jade-tint);border-radius:12px;padding:12px 0">
           <div class="num" style="font-size:30px;font-weight:700;color:var(--jade-ink)">380</div>
           <div class="muted" style="font-size:11px">vacíos recogidos</div></div>
       </div>
       <div style="display:flex;align-items:center;margin-top:11px;padding-top:11px;border-top:1px solid var(--line-soft)">
         <span class="sm soft">Saldo de la dependencia</span><div class="spacer"></div>
         <span class="chip a">+20 → 340 garrafones</span></div>
     </div>
     <div class="card pad" style="margin-bottom:12px;padding:14px 16px">
       <div class="muted" style="font-size:11px;margin-bottom:8px">RECIBIÓ</div>
       <div class="b sm">Lic. Karla Domínguez</div>
       <div class="muted" style="font-size:11px;margin-top:2px">Jefa de almacén · sello y firma capturados</div>
       <div style="margin-top:10px;height:64px;border:1.5px dashed var(--line);border-radius:10px;display:grid;place-items:center;background:var(--paper)">
         <span style="font-family:'Comic Sans MS',cursive;font-size:20px;color:var(--ink-soft);transform:rotate(-4deg)">K. Domínguez</span></div>
     </div>
     <div style="display:flex;gap:10px">
       <div class="btn ghost" style="flex:1;justify-content:center">Foto del sello</div>
       <div class="btn" style="flex:1;justify-content:center">Confirmar entrega</div></div>
     <div class="muted" style="font-size:10.5px;text-align:center;margin-top:10px">Sin señal también funciona — se sincroniza al volver a la planta.</div>
     <div class="card pad" style="margin-top:12px;padding:13px 15px">
       <div class="muted" style="font-size:11px;margin-bottom:7px">SIGUIENTE PARADA</div>
       <div style="display:flex;align-items:center;gap:10px">
         <div class="chip p" style="width:30px;height:30px;padding:0;justify-content:center;border-radius:9px">${ic("truck")}</div>
         <div><div class="b sm">Hospital General de Zona</div>
         <div class="muted" style="font-size:11px;margin-top:1px">R-1043 · 160 llenos · recoger vacíos</div></div>
         <div class="spacer"></div><span class="chip">13:30</span></div>
     </div>
   </div>`);
console.log("planta gen 4: remision móvil");
