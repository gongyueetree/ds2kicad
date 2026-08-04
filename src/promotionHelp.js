// src/promotionHelp.js — 晋升阻断原因 → 中文说明 + 处理位置。
// 独立成纯 .js 模块（不含 JSX），以便被 node --test 直接引入做覆盖率校验：
// lib/promotion.js 的 BLOCK 每新增一个枚举值，这里必须同步补文案，否则用例失败。

export const REASON_HELP = {
  no_authenticated_ezplm_session: ['无已认证的 ezPLM 会话', '需配置 EZPLM_JWT_SECRET/ISS/AUD 并携带真实 JWT 进入；AUTH_MODE=dev 的匿名身份恒不可晋升'],
  mock_data: ['演示数据', '配置 GEMINI_API_KEY 后重新提取'],
  no_confirmed_figures: ['没有已确认的图区', '到 ④ 确认至少一张图，然后重新点击生成（闸门读的是 IR 里的 confirmed）'],
  figure_evidence_missing: ['该图缺少证据锚点', '重新框选并「确认此图（截取并上传）」'],
  missing_required_geometry: ['封装关键尺寸缺失', '到 ③ 对照机械图补齐标红字段'],
  default_value_used: ['字段用了默认兜底值', '到 ③ 用手册实测值覆盖'],
  field_evidence_default_value: ['字段证据为默认值', '到 ③ 对照机械图确认或改写该字段'],
  package_field_evidence_unverified: ['封装字段证据未经核实', '到 ③ 逐项对照机械图确认（删除证据不会放行，缺锚点直接判阻断）'],
  pin_field_evidence_unverified: ['管脚字段被人工改过但缺审核者锚点', '到 ② 重新确认相关管脚'],
  value_out_of_range_clamped: ['数值超范围被截断', '手册值本身可疑，到 ③ 核对原始数值'],
  rule_or_jedec_derived: ['数值由 JEDEC 先验推导', '到 ③ 用手册实测值替换'],
  land_pattern_derived_not_from_datasheet: ['焊盘由规则推导', '到 ③ 填入手册推荐 land pattern'],
  geometry_auto_corrected: ['几何被自动修正过', '到 ③ 复核被修正的字段'],
  geometry_transformation_applied: ['几何做过归一化变换', '到 ③ 复核变换涉及的字段'],
  pin_data_transformed_requires_review: ['管脚数据经过转换', '到 ② 逐行复核管脚表'],
  pin_count_or_number_conflict: ['管脚数或编号冲突', '到 ② 修正管脚表与 ③ 的 pinCount'],
  unsupported_package_family: ['封装家族暂不支持', '当前只输出符号，封装需人工绘制'],
  required_output_missing: ['缺少必需的产物文件', '检查生成告警，通常由几何缺失导致'],
  reviewer_edit_without_provenance: ['人工修改缺少审核者身份', '需在已认证会话下重新修改'],
  validation_error: ['结构化校验失败', '见生成告警中的具体字段'],
  field_evidence_model_inference: ['字段证据为模型推断', '到 ③ 对照手册确认'],
  field_evidence_unverified: ['字段证据未经核实', '到 ③ 对照手册确认'],
  approximate_parametric_3d_not_vendor_step: [
    '参数化 WRL 不是厂商 STEP',
    '结构性阻断：只要生成了参数化 3D 就必然触发，补数据无法清除，需引入厂商 STEP（该链路尚未实现）'
  ]
};
