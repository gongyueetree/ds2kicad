import {test,expect} from '@playwright/test';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {issueDevSession} from '../lib/auth.js';
const secret=process.env.E2E_SESSION_SECRET;
test.skip(!secret,'Set E2E_SESSION_SECRET to the local test server JWT secret.');
async function fixture(){
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]),font=await doc.embedFont(StandardFonts.Helvetica);
  const rows=['TEST358 operational amplifier','Recommended operating conditions','TA = 25 C','Parameter  Min  Typ  Max  Unit','Supply voltage  2  3.3  5.5  V',...Array.from({length:22},(_,i)=>`Synthetic fixture line ${i}`)];
  rows.forEach((text,i)=>{if(i===3||i===4)text.split('  ').forEach((s,j)=>page.drawText(s,{x:[30,220,300,380,460][j],y:750-i*20,size:10,font}));else page.drawText(text,{x:30,y:750-i*20,size:10,font});});return Buffer.from(await doc.save());
}
test('parameter workflow works in browser, survives reload, and fits a phone viewport',async({page,baseURL})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  if (!process.env.E2E_PREVIEW_CODE) await page.context().addCookies([{name:'ezplm_session',value:issueDevSession({sub:'e2e-reviewer',tenantId:'e2e-data',roles:['publisher']},secret),url:baseURL}]);
  await page.goto('/');
  if (process.env.E2E_PREVIEW_CODE) {
    await page.getByLabel('测试访问码').fill(process.env.E2E_PREVIEW_CODE);
    await page.getByRole('button',{name:'进入测试',exact:true}).click();
    await expect(page.getByText('DS2KiCad v1.3 测试环境',{exact:false})).toBeVisible();
  }
  await expect(page.getByRole('heading',{name:/DS2KiCad/})).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({path:'/tmp/ds2-home.png',fullPage:true});
  await page.getByLabel('提取范围').selectOption('data');await page.getByLabel('目标型号').fill('TEST358');
  const response=page.waitForResponse(r=>r.url().includes('/api/platform-extract')&&r.request().method()==='POST');
  await page.locator('.upload-row input[type=file]').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:await fixture()});
  const data=await (await response).json();expect(data.jobId).toBeTruthy();
  await expect(page.getByRole('heading',{name:'器件数据资产',exact:true})).toBeVisible();
  await expect(page.locator('.asset-observation')).toHaveCount(1);
  await page.getByLabel('参数审核理由').fill('对照原文表格核实');
  await page.getByLabel('参数资产厂商').fill('Example');
  await page.getByRole('button',{name:'保存器件身份',exact:true}).click();
  await page.getByRole('button',{name:'确认类别',exact:true}).click();
  await expect(page.getByText('类别已确认',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'核对 / 修正'}).click();await page.getByLabel('适用型号').fill('TEST358');
  await page.getByRole('button',{name:'保存并接受参数'}).click();
  await expect(page.locator('.asset-status.status-accepted')).toHaveText('已接受');
  await page.getByRole('button',{name:'发布参数资产',exact:true}).click();
  await expect(page.getByText('1 个已发布版本')).toBeVisible();
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载已发布版本'}).click();
  expect((await downloadEvent).suggestedFilename()).toBe('component-data-published.json');
  await page.goto(`/?job=${data.jobId}`);await expect(page.getByText('1 个已发布版本')).toBeVisible();
  await page.screenshot({path:'/tmp/ds2-data-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/ds2-data-mobile.png',fullPage:true});
  const overflow=await page.locator('.data-assets-panel').evaluate(el=>el.scrollWidth>el.clientWidth+2);expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
