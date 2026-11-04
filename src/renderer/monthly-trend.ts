/** 12个月结算趋势 SVG，可嵌入家庭卡片和设置页。未知值留空，真实零保留。 */
import { escapeXml } from './format.js';
export interface TrendPoint {month:string; usage:number|null; charge:number|null;}
export function renderMonthlyTrend(points:TrendPoint[],options:{x?:number;y?:number;width?:number;height?:number;theme?:'light'|'dark';mode?:'usage'|'charge';fontScale?:number}={}) {
 const x=options.x||0,y=options.y||0,w=options.width||1120,h=options.height||220,mode=options.mode||'usage',dark=options.theme==='dark';
 const ink=dark?'#94AABA':'#6C818D',accent=dark?'#4BDAC2':'#007F73',bg=dark?'#192A38':'#F3F7F8',values=points.map(p=>p[mode]);
 const max=Math.max(1,...values.filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0));
 const bottom=h-24,top=32,plot=Math.max(12,bottom-top),slot=(w-28)/Math.max(1,points.length),bar=Math.max(2,slot*.48);
 const scale=options.fontScale||1;
 const title=mode==='usage'?'近12个结算月 · 电量 kWh':'近12个结算月 · 电费 元';
 return `<g transform="translate(${x},${y})" data-role="monthly-trend"><rect width="${w}" height="${h}" rx="14" fill="${bg}"/><text x="14" y="20" font-size="${15*scale}" fill="${ink}">${title}${points.length?' · '+escapeXml(points[0].month)+'—'+escapeXml(points.at(-1)!.month):''}</text>`+
 points.map((p,i)=>{const value=p[mode],known=typeof value==='number'&&Number.isFinite(value)&&value>=0,bh=known?Math.max(1,value/max*plot):0,cx=14+(i+.5)*slot;
 const label=p.month.slice(5)==='01'?p.month.slice(2,4)+'/01':p.month.slice(5);
 return `<g><title>${escapeXml(p.month)} · ${known?value.toFixed(2):'暂无数据'} ${mode==='usage'?'kWh':'元'}</title>`+
 (known?`<rect x="${cx-bar/2}" y="${bottom-bh}" width="${bar}" height="${bh}" rx="3" fill="${accent}"/>`:`<line x1="${cx-bar/2}" y1="${bottom}" x2="${cx+bar/2}" y2="${bottom}" stroke="${ink}" stroke-dasharray="3 3"/>`)+
 `<text x="${cx}" y="${known?Math.max(30,bottom-bh-4):bottom-6}" text-anchor="middle" font-size="${11*scale}" fill="${ink}">${known?Number(value.toFixed(1)):'—'}</text><text x="${cx}" y="${h-8}" text-anchor="middle" font-size="${12*scale}" fill="${ink}">${escapeXml(label)}</text></g>`;}).join('')+'</g>';
}
export function monthlyTrendSvg(points:TrendPoint[],options:{theme?:'light'|'dark';mode?:'usage'|'charge'}={}) {return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 260" role="img" aria-label="近12个月结算趋势">${renderMonthlyTrend(points,{...options,height:260,fontScale:1.25})}</svg>`;}
