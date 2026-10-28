# edamax-adaptive-pour

A JLCEDA Pro (V3) extension. After a pad is modified or moved, it rebuilds the
copper pours on the affected layers with the editor's own pour engine, then runs
DRC and reports only the errors that are new.

- Top/bottom SMD pads rebuild only their own layer; `MULTI` (through-hole) pads
  rebuild every copper layer.
- Rapid edits are debounced into one rebuild (220 ms) so the editor is not blocked.
- Pours are rebuilt in their existing priority order.
- DRC is compared before and after; only newly introduced errors are shown.
- PCB header menu "智能铺铜": rebuild all layers, toggle auto mode, about.

It uses only the official extension API (`eda.*`), e.g.
`eda.pcb_Layer.getTheNumberOfCopperLayers`, `eda.pcb_PrimitivePour.getAll`,
`eda.pcb_PrimitivePad.get`, `eda.pcb_Drc.check`, `eda.sys_Message.showToastMessage`.

## Build

This directory holds the extension's own files (`extension.json`, `src/index.ts`,
`locales/`). Build them with the official extension SDK template:

1. Create a project from JLCEDA's official `pro-api-sdk` extension template
   (it provides the esbuild config, packaging script and `@jlceda/pro-api-types`).
2. Copy `extension.json`, `src/index.ts` and `locales/` over the template's files.
3. Add a logo at `images/logo.png` (referenced by `extension.json`; not included).
4. `npm install && npm run build`, then import the `.eext` from `build/dist/`
   through the extension manager in JLCEDA Pro.

Current version listens to pad `modify` events. Precise start/end layers for
blind/buried vias and dirty-rectangle filtering are not implemented yet.

## 中文

嘉立创 EDA 专业版 V3 扩展：焊盘修改或移动后，用编辑器自带的铺铜内核重建受影响的铜层，再跑 DRC，只提示新增的错误。
只调用官方扩展 API（`eda.*`）。构建需套用官方扩展 SDK 模板，把本目录的文件覆盖进去后 `npm run build`。
