import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const CRC_TABLE=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c}return t})();
const crc32=(b)=>{let c=0xffffffff;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0};
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc])}
export function makePng(w=2,h=2){
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const rows=[]; for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*4); row[0]=0; for(let x=0;x<w;x++){row[1+x*4]=200;row[2+x*4]=100;row[3+x*4]=50;row[4+x*4]=255} rows.push(row)}
  const idat=deflateSync(Buffer.concat(rows));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
}

