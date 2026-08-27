const pptxgen = require("pptxgenjs");
const path = require("path");
const SHOT = (n) => path.join(__dirname, "planta", "png", n + ".png");

const C = { deep:"0C3D55", deeper:"082E41", mid:"2E6E8E", tint:"E7F3F8",
  aqua:"0E93B8", aquaBright:"7FD4EA",
  ink:"1A222E", inkSoft:"515963", muted:"6B7280", line:"DFE6EA", soft:"F5F9FB", white:"FFFFFF",
  jade:"199D78", amberInk:"7A4318" };
const HEAD="Cambria", BODY="Calibri";
const W=13.333, H=7.5, M=0.7, CW=W-2*M;
const AR = 1600/920;
const sh = (o={}) => ({ type:"outer", color:"05202E", blur:12, offset:3, angle:90, opacity:0.16, ...o });

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "Contabilidad OS";
pres.title = "Planta purificadora — Sistema integral";

const dark = (s) => s.addShape(pres.ShapeType.rect,{x:0,y:0,w:W,h:H,fill:{color:C.deep},line:{width:0}});
const foot = (s,n,light) => {
  s.addText("Planta purificadora",{x:M,y:H-0.46,w:4,h:0.26,fontFace:BODY,fontSize:9.5,color:light?"7FA6B8":C.muted,margin:0});
  s.addText(String(n),{x:W-M-1,y:H-0.46,w:1,h:0.26,fontFace:BODY,fontSize:9.5,color:light?"7FA6B8":C.muted,align:"right",margin:0});
};
function shotSlide(n, kicker, title, solves, img) {
  const s = pres.addSlide();
  s.addText(kicker.toUpperCase(),{x:M,y:0.45,w:7,h:0.24,fontFace:BODY,fontSize:10.5,bold:true,color:C.aqua,charSpacing:2,margin:0});
  s.addText(title,{x:M,y:0.72,w:7.6,h:0.46,fontFace:HEAD,fontSize:23,bold:true,color:C.ink,margin:0});
  s.addText([{text:"RESUELVE   ",options:{bold:true,color:C.aqua,fontSize:9.5,charSpacing:1.4}},
             {text:solves,options:{color:C.inkSoft,fontSize:12.5}}],
    {x:W-M-4.7,y:0.5,w:4.7,h:0.62,fontFace:BODY,align:"right",valign:"middle",margin:0});
  const iy=1.26, ih=H-iy, iw=ih*AR, ix=(W-iw)/2;
  s.addImage({path:img,x:ix,y:iy,w:iw,h:ih});
  return s;
}
function bleedSlide(img) {
  const s = pres.addSlide(); dark(s);
  const iw=W, ih=iw/AR;
  s.addImage({path:img,x:0,y:(H-ih)/2,w:iw,h:ih});
  return s;
}
function card(s,o){
  s.addShape(pres.ShapeType.roundRect,{x:o.x,y:o.y,w:o.w,h:o.h,rectRadius:0.1,
    fill:{color:o.fill||C.soft},line:{color:o.line||C.line,width:0.75},shadow:sh({opacity:0.08,blur:8})});
}
function bullets(s,items,o){
  s.addText(items.map((t,i)=>({text:t,options:{bullet:true,breakLine:i!==items.length-1}})),
    {x:o.x,y:o.y,w:o.w,h:o.h,fontFace:BODY,fontSize:o.size||13.5,color:o.color||C.ink,
     paraSpaceAfter:o.gap===undefined?11:o.gap,lineSpacingMultiple:1.15,margin:0,valign:"top"});
}
const head = (s,title,kicker,sub) => {
  let y=0.5;
  if(kicker){s.addText(kicker.toUpperCase(),{x:M,y,w:CW,h:0.24,fontFace:BODY,fontSize:10.5,bold:true,color:C.aqua,charSpacing:2,margin:0});y+=0.32;}
  s.addText(title,{x:M,y,w:CW,h:0.58,fontFace:HEAD,fontSize:29,bold:true,color:C.ink,margin:0});y+=0.68;
  if(sub){s.addText(sub,{x:M,y,w:CW-0.6,h:0.44,fontFace:BODY,fontSize:14,color:C.muted,margin:0});y+=0.6;}
  return y+0.2;
};

/* ── 1 · Portada ────────────────────────────────────────────────────────── */
let s = pres.addSlide(); dark(s);
s.addShape(pres.ShapeType.ellipse,{x:9.9,y:-1.8,w:6.2,h:6.2,fill:{color:C.mid,transparency:68},line:{width:0}});
s.addShape(pres.ShapeType.ellipse,{x:11.4,y:3.9,w:3.6,h:3.6,fill:{color:C.aqua,transparency:76},line:{width:0}});
s.addText("PROPUESTA DE SISTEMA INTEGRAL · PLANTA PURIFICADORA",{x:M,y:1.95,w:10,h:0.3,fontFace:BODY,fontSize:12,bold:true,color:C.aquaBright,charSpacing:2.4,margin:0});
s.addText("Cada litro y cada garrafón, contados",{x:M,y:2.42,w:10.6,h:1.7,fontFace:HEAD,fontSize:47,bold:true,color:C.white,margin:0});
s.addText("Producción  ·  Envases  ·  Remisiones  ·  Gobierno  ·  Normatividad  ·  Contabilidad",
  {x:M,y:4.5,w:11,h:0.34,fontFace:BODY,fontSize:13.5,color:C.aquaBright,margin:0});
s.addText("Agosto 2026",{x:M,y:6.5,w:9,h:0.3,fontFace:BODY,fontSize:12,color:"7FA6B8",margin:0});
s.addNotes("Portada. El nombre de la planta del cliente sustituye la línea genérica cuando lo tengamos — es una constante del generador.");

/* ── 2 · Lo que hoy no se sabe ──────────────────────────────────────────── */
s = pres.addSlide();
let y = head(s,"Lo que hoy nadie puede contestar","El punto de partida",
  "No por descuido: porque la operación vive en talones, cuadernos y memoria.");
[["¿Cuánta agua compraste y cuánta vendiste?","Las pipas entran, los garrafones salen — y la diferencia no la mide nadie."],
 ["¿Cuántos garrafones tuyos tiene cada dependencia?","El envase es el activo del negocio y circula sin saldo por cliente."],
 ["¿Qué remisiones ya se pueden facturar?","El talón sellado vive en una carpeta en el camión."],
 ["¿Cuánto te debe gobierno y desde cuándo?","Facturas a 30–45 días, sin semáforo de vencimiento."],
 ["¿La bitácora aguanta una visita de COFEPRIS?","Cloro, lavados y análisis en cuadernos que hay que buscar."],
 ["¿El negocio gana lo que crees?","Sin costo por litro ni merma, la utilidad es una corazonada."]]
 .forEach(([t,b],i)=>{
  const cx=M+(i%3)*4.05, cy=y+Math.floor(i/3)*2.24;
  card(s,{x:cx,y:cy,w:3.8,h:2.02});
  s.addText(t,{x:cx+0.3,y:cy+0.28,w:3.2,h:0.62,fontFace:BODY,fontSize:14,bold:true,color:C.ink,lineSpacingMultiple:1.05,margin:0});
  s.addText(b,{x:cx+0.3,y:cy+0.98,w:3.2,h:0.82,fontFace:BODY,fontSize:11.8,color:C.muted,lineSpacingMultiple:1.16,margin:0});
});
foot(s,2);
s.addNotes("Seis preguntas sin respuesta hoy. Cada pantalla del deck contesta una.");

/* ── 3 · Los dos ciclos ─────────────────────────────────────────────────── */
s = pres.addSlide(); dark(s);
s.addText("LA PROPUESTA",{x:M,y:0.66,w:CW,h:0.3,fontFace:BODY,fontSize:11.5,bold:true,color:C.aquaBright,charSpacing:2.4,margin:0});
s.addText("Dos ciclos cerrados, ambos contados",{x:M,y:1.06,w:CW,h:0.66,fontFace:HEAD,fontSize:34,bold:true,color:C.white,margin:0});
const cyc=(cy,label,steps,accent)=>{
  s.addText(label,{x:M,y:cy-0.42,w:5,h:0.3,fontFace:BODY,fontSize:12,bold:true,color:accent,charSpacing:1.6,margin:0});
  const nw=2.12,ng=0.27;
  steps.forEach(([t,sub],i)=>{
    const nx=M+i*(nw+ng);
    s.addShape(pres.ShapeType.roundRect,{x:nx,y:cy,w:nw,h:1.18,rectRadius:0.1,fill:{color:C.deeper},line:{color:C.mid,width:1}});
    s.addText(t,{x:nx+0.14,y:cy+0.18,w:nw-0.28,h:0.3,fontFace:BODY,fontSize:13.5,bold:true,color:C.white,margin:0});
    s.addText(sub,{x:nx+0.14,y:cy+0.52,w:nw-0.28,h:0.5,fontFace:BODY,fontSize:10.5,color:"9CC2D2",lineSpacingMultiple:1.1,margin:0});
    if(i<steps.length-1) s.addShape(pres.ShapeType.rightArrow,{x:nx+nw+0.045,y:cy+0.49,w:0.18,h:0.2,fill:{color:accent},line:{width:0}});
  });
};
cyc(2.35,"EL CICLO DEL AGUA",[["Pipa","litros que entran"],["Producción","la máquina llena"],["Remisión","llenos que salen"],["Factura","CFDI · IVA 0%"],["Banco","cobro y REP"]],C.aqua);
cyc(4.35,"EL CICLO DEL ENVASE",[["Sale lleno","con remisión"],["Regresa vacío","mismo viaje"],["Se lava","bitácora"],["Se llena","vuelve a salir"],["Saldo","por cliente"]],"E8A33D");
s.addText("Litros comprados vs. litros embotellados = rendimiento. Salieron − regresaron = saldo de envases. Si un número no cuadra, el sistema lo dice.",
  {x:M,y:5.95,w:CW,h:0.6,fontFace:HEAD,fontSize:15.5,italic:true,color:C.aquaBright,margin:0});
foot(s,3,true);
s.addNotes("La lámina que define el producto. El hospital tenía una cadena; la planta tiene dos ciclos que cierran.");


/* ── 4-11 · El producto en pantalla ─────────────────────────────────────── */
const SHOTS = [
 ["tablero","Tablero del dueño","La planta en una pantalla",
  "Enterarse de lo que pasa sin estar en la planta.",
  "Producción del día, garrafones fuera, cartera de gobierno y las alertas que requieren decisión."],
 ["produccion","Producción","La misma máquina, ahora con memoria",
  "Saber cuánta agua entró, cuánta salió y dónde quedó la diferencia.",
  "La pantalla espeja el diagrama de la PORTAQUA. El contador del turno se captura al cierre y el sistema cuadra litros comprados contra embotellados."],
 ["envases","Envases en comodato","Los garrafones que no regresan, con nombre",
  "El activo del negocio circulando sin saldo por cliente.",
  "Salieron menos regresaron, remisión por remisión. Dos dependencias con saldo creciendo aparecen en amber antes de que sea dinero perdido."],
 ["gobierno","Contratos con gobierno","El contrato, no la corazonada",
  "Vender contra un tope que nadie está midiendo.",
  "Precio pactado, vigencia y consumo contra tope. El contrato del HGZ llega al tope en 9 semanas — tiempo de gestionar la ampliación."],
 ["cartera","Cartera de gobierno","Cuánto te deben y desde cuándo",
  "Cobranza a 30–45 días administrada de memoria.",
  "Remitido, facturado y cobrado por dependencia. La factura vencida del HGZ aparece en rojo con sus días encima del plazo."],
 ["estadocuenta","Estado de cuenta y CFDI","El soporte que gobierno pide, listo",
  "Armar la factura del mes buscando talones.",
  "El consumo mensual por punto de entrega, cuadrado con remisiones selladas, y el CFDI PPD con IVA 0% en un clic."],
 ["normatividad","Normatividad","COFEPRIS se contesta imprimiendo",
  "Bitácoras en cuadernos y análisis vencidos sin aviso.",
  "Cloro por turno, lavados, mantenimiento de filtros y análisis con vigencias. Lo que está por vencer avisa solo."],
];
SHOTS.forEach(([img,kicker,title,solves,note])=>{
  const sl = shotSlide(0,kicker,title,solves,SHOT(img));
  sl.addNotes(note);
});
const b1 = bleedSlide(SHOT("remision"));
b1.addNotes("La remisión móvil: entrega llenos, recoge vacíos, captura quién recibió. Funciona sin señal.");

/* ── 12 · Un día en la planta ───────────────────────────────────────────── */
s = pres.addSlide(); dark(s);
s.addText("EL RECORRIDO COMPLETO",{x:M,y:0.62,w:CW,h:0.3,fontFace:BODY,fontSize:11.5,bold:true,color:C.aquaBright,charSpacing:2.4,margin:0});
s.addText("Un lunes en la planta",{x:M,y:1.02,w:CW,h:0.64,fontFace:HEAD,fontSize:34,bold:true,color:C.white,margin:0});
s.addText("Una pipa recorre el sistema completo. Nadie captura la misma información dos veces.",
  {x:M,y:1.74,w:11,h:0.38,fontFace:BODY,fontSize:14,color:"C6DDE7",margin:0});
[["07:40","Llega la pipa","20,000 L de Pipas del Valle — queda como compra con su CFDI."],
 ["08:00","Produce la máquina","980 garrafones (910×20L, 70×19L). Contador de la HMI al cierre."],
 ["11:20","Sale la remisión","R-1042: 400 llenos a la Secretaría; 380 vacíos de regreso."],
 ["11:21","El saldo se mueve","La dependencia queda en +340 garrafones — alerta amber."],
 ["14:00","La bitácora se llena","Cloro 1.1 ppm, dentro de norma. Con hora y responsable."],
 ["Fin de mes","Estado de cuenta","8,400 garrafones · $121,800 · cuadrado con 23 remisiones."],
 ["Día 1 sep","Se factura","CFDI PPD consolidado, IVA 0%, con remisiones anexas."],
 ["Día 45","Se cobra","Entra al banco, se concilia, el REP sale antes del día 5."]]
 .forEach(([h,t,b],i)=>{
  const col=i%4,row=Math.floor(i/4), dw=2.92,dg=0.25, dx=M+col*(dw+dg), dy=2.4+row*2.24;
  s.addShape(pres.ShapeType.roundRect,{x:dx,y:dy,w:dw,h:1.96,rectRadius:0.1,fill:{color:C.deeper},line:{color:C.mid,width:1}});
  s.addText(h,{x:dx+0.26,y:dy+0.24,w:dw-0.52,h:0.28,fontFace:BODY,fontSize:11,bold:true,color:C.aquaBright,charSpacing:1,margin:0});
  s.addText(t,{x:dx+0.26,y:dy+0.56,w:dw-0.52,h:0.32,fontFace:BODY,fontSize:14.5,bold:true,color:C.white,margin:0});
  s.addText(b,{x:dx+0.26,y:dy+0.92,w:dw-0.52,h:0.92,fontFace:BODY,fontSize:11.5,color:"9CC2D2",lineSpacingMultiple:1.14,margin:0});
  if(col<3) s.addShape(pres.ShapeType.rightArrow,{x:dx+dw+0.03,y:dy+0.88,w:0.19,h:0.2,fill:{color:C.aqua},line:{width:0}});
});
foot(s,12,true);

/* ── 13 · Hereda vs construye ───────────────────────────────────────────── */
s = pres.addSlide();
y = head(s,"Qué ya existe y qué se construye","Entrega",
  "La plataforma ya opera negocios de agua purificada. Lo nuevo es la capa de planta y gobierno.");
[["Ya existe y está probado",C.soft,C.ink,C.jade,
  ["Ventas, reparto y corte del día del chofer","Compras a proveedores e insumos de planta",
   "Precio pactado por cliente y sucursales","Estado de cuenta mensual y facturación CFDI",
   "Portal del cliente con sus facturas","Bancos, conciliación y complementos de pago",
   "Contabilidad completa y estados financieros","Nómina con IMSS, Infonavit y Fonacot"]],
 ["Se construye para esta planta",C.deep,C.white,C.aqua,
  ["Producción: pipas, lotes y rendimiento por turno","Contadores de la máquina capturados al cierre",
   "Envases en comodato: saldo por cliente","Remisiones con vacíos y evidencia de recibido",
   "Contratos de gobierno: tope, vigencia, días de pago","Cartera por dependencia con semáforo",
   "Bitácoras sanitarias y análisis con vigencias","App del chofer (funciona sin señal)"]]]
 .forEach(([t,bg,txt,dot,items],i)=>{
  const cx=M+i*6.13;
  s.addShape(pres.ShapeType.roundRect,{x:cx,y:y+0.04,w:5.89,h:3.78,rectRadius:0.12,
    fill:{color:bg},line:{color:i?bg:C.line,width:0.75},shadow:sh({opacity:0.1,blur:8})});
  s.addShape(pres.ShapeType.ellipse,{x:cx+0.34,y:y+0.32,w:0.44,h:0.44,fill:{color:dot},line:{width:0}});
  s.addText(t,{x:cx+0.94,y:y+0.34,w:4.7,h:0.4,fontFace:BODY,fontSize:15.5,bold:true,color:txt,valign:"middle",margin:0});
  bullets(s,items,{x:cx+0.34,y:y+0.98,w:5.21,h:2.7,size:12.2,gap:8,color:i?"C6DDE7":C.ink});
});
foot(s,13);

/* ── 14 · Inversión ─────────────────────────────────────────────────────── */
s = pres.addSlide();
y = head(s,"Inversión","Entrega",
  "Un solo sistema para la planta: operación, facturación, cobranza a gobierno, normatividad y contabilidad.");
card(s,{x:M,y:y+0.02,w:6.0,h:3.56});
s.addText("Lo que sustituye",{x:M+0.34,y:y+0.26,w:5.32,h:0.32,fontFace:BODY,fontSize:14.5,bold:true,color:C.ink,margin:0});
bullets(s,["El talonario de remisiones y la carpeta del camión","Los cuadernos de bitácora y el archivo de análisis",
  "El Excel de cortes, saldos y facturación","La contabilidad armada a mano cada mes",
  "La memoria como sistema de cobranza"],{x:M+0.34,y:y+0.72,w:5.3,h:2.6,size:13,gap:10,color:C.inkSoft});
const px=7.4,pw=W-M-px;
s.addShape(pres.ShapeType.roundRect,{x:px,y:y+0.02,w:pw,h:3.56,rectRadius:0.12,fill:{color:C.deep},line:{width:0},shadow:sh({blur:14,opacity:0.2})});
s.addText("LA PROPUESTA",{x:px+0.4,y:y+0.26,w:pw-0.8,h:0.28,fontFace:BODY,fontSize:11,bold:true,color:C.aquaBright,charSpacing:2,margin:0});
s.addText("$12,000",{x:px+0.4,y:y+0.6,w:pw-0.8,h:0.86,fontFace:HEAD,fontSize:50,bold:true,color:C.white,margin:0});
s.addText("pesos al mes  ·  un solo sistema",{x:px+0.4,y:y+1.48,w:pw-0.8,h:0.32,fontFace:BODY,fontSize:13.5,color:"9CC2D2",margin:0});
bullets(s,["Implementación incluida — sin inversión inicial","Usuarios ilimitados: planta, oficina y choferes",
  "Todos los módulos, sin cobro por separado","Contrato a 24 meses"],
  {x:px+0.4,y:y+2.0,w:pw-0.8,h:1.4,size:12.8,gap:8,color:C.white});
s.addText("Puesta en marcha en 4 a 6 semanas: catálogos, contratos, parque de envases y capacitación.",
  {x:M,y:y+3.76,w:CW,h:0.42,fontFace:HEAD,fontSize:15,italic:true,color:C.deep,margin:0});
foot(s,14);
s.addNotes("Precio dentro del rango acordado ($12–15k). Es una constante del generador — se ajusta antes de la junta si hace falta.");

/* ── 15 · Cierre ────────────────────────────────────────────────────────── */
s = pres.addSlide(); dark(s);
s.addShape(pres.ShapeType.ellipse,{x:10.9,y:-1.5,w:5,h:5,fill:{color:C.mid,transparency:72},line:{width:0}});
s.addText("SIGUIENTES PASOS",{x:M,y:0.66,w:CW,h:0.3,fontFace:BODY,fontSize:11.5,bold:true,color:C.aquaBright,charSpacing:2.4,margin:0});
s.addText("Tres pasos para arrancar",{x:M,y:1.06,w:10.6,h:0.64,fontFace:HEAD,fontSize:33,bold:true,color:C.white,margin:0});
[["1","Visita a la planta","Media jornada: recorrido de producción, reparto y oficina para afinar catálogos y rutas."],
 ["2","Datos de arranque","Contratos vigentes, padrón de clientes, parque de garrafones y plantilla de personal."],
 ["3","Puesta en marcha","Capacitación por puesto — chofer, producción, oficina — y arranque en paralelo."]]
 .forEach(([n,t,b],i)=>{
  const cx=M+i*4.14;
  s.addShape(pres.ShapeType.roundRect,{x:cx,y:2.2,w:3.9,h:2.5,rectRadius:0.12,fill:{color:C.deeper},line:{color:C.mid,width:1}});
  s.addShape(pres.ShapeType.ellipse,{x:cx+0.3,y:2.5,w:0.5,h:0.5,fill:{color:C.aqua},line:{width:0}});
  s.addText(n,{x:cx+0.3,y:2.5,w:0.5,h:0.5,fontFace:HEAD,fontSize:16,bold:true,color:C.white,align:"center",valign:"middle",margin:0});
  s.addText(t,{x:cx+0.3,y:3.16,w:3.3,h:0.34,fontFace:BODY,fontSize:15.5,bold:true,color:C.white,margin:0});
  s.addText(b,{x:cx+0.3,y:3.54,w:3.3,h:1.0,fontFace:BODY,fontSize:12,color:"9CC2D2",lineSpacingMultiple:1.18,margin:0});
});
s.addText("La misma plataforma que lleva la contabilidad, los bancos y la nómina — la planta se suma, no empieza de cero.",
  {x:M,y:5.3,w:11.5,h:0.6,fontFace:HEAD,fontSize:15.5,italic:true,color:C.aquaBright,margin:0});
s.addText("Planta purificadora  ·  Propuesta de sistema integral  ·  Agosto 2026",{x:M,y:6.62,w:CW,h:0.32,fontFace:BODY,fontSize:11.5,color:"7FA6B8",margin:0});
s.addNotes("Cerrar pidiendo la visita de media jornada — compromiso chico que destraba todo.");

pres.writeFile({ fileName: process.argv[2] }).then(()=>console.log("OK ->", process.argv[2]));
