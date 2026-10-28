import * as extensionConfig from '../extension.json';

const TOP = 1;
const BOTTOM = 2;
const MULTI = 12;
const FIRST_INNER = 21;
const PAD_EVENT_LISTENER_ID = 'edamax-adaptive-pour-pad-modify';
const AUTO_CONFIG_KEY = 'automaticRebuild';
const DEBOUNCE_MS = 220;

let automaticRebuild = true;
let rebuildRunning = false;
let pendingLayers = new Set<number>();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function allCopperLayers(layerCount: number): number[] {
	if (!Number.isInteger(layerCount) || layerCount < 2 || layerCount > 32) {
		throw new Error(`Unsupported copper layer count: ${layerCount}`);
	}
	return [TOP, ...Array.from({ length: layerCount - 2 }, (_, index) => FIRST_INNER + index), BOTTOM];
}

async function layersForPad(pad: any): Promise<number[]> {
	const layer = pad.getState_Layer();
	if (layer !== MULTI) return [layer];
	return allCopperLayers(await eda.pcb_Layer.getTheNumberOfCopperLayers());
}

function isPadPrimitiveType(value: unknown): boolean {
	const normalized = String(value ?? '').toLowerCase();
	return normalized === 'pad' || normalized.endsWith('.pad');
}

function drcKey(error: any): string {
	const ids = [error?.id1, error?.id2, error?.primitiveId, error?.relatedPrimitiveId]
		.filter(value => value != null)
		.map(String)
		.sort();
	return JSON.stringify([
		error?.ruleType ?? error?.type ?? error?.rule ?? error?.name ?? 'unknown',
		error?.layerId ?? error?.layer ?? '',
		ids,
		error?.x ?? error?.position?.x ?? error?.location?.x ?? '',
		error?.y ?? error?.position?.y ?? error?.location?.y ?? '',
	]);
}

async function rebuildLayers(layers: ReadonlySet<number>): Promise<number> {
	const pours = (await eda.pcb_PrimitivePour.getAll())
		.filter((pour: any) => layers.has(pour.getState_Layer()))
		.sort((a: any, b: any) =>
			(a.getState_PourPriority?.() ?? 0) - (b.getState_PourPriority?.() ?? 0));

	for (const pour of pours) await pour.rebuildCopperRegion();
	return pours.length;
}

async function drainRebuildQueue(): Promise<void> {
	if (rebuildRunning || pendingLayers.size === 0) return;
	rebuildRunning = true;
	const layers = pendingLayers;
	pendingLayers = new Set<number>();
	try {
		const before = await eda.pcb_Drc.check(true, false, true);
		const count = await rebuildLayers(layers);
		const after = await eda.pcb_Drc.check(true, false, true);
		const beforeKeys = new Set(before.map(drcKey));
		const added = after.filter((error: unknown) => !beforeKeys.has(drcKey(error)));
		if (added.length > 0) {
			eda.sys_Message.showToastMessage(
				`智能铺铜完成，但新增 ${added.length} 个 DRC；请运行详细检查。`,
				'warn' as ESYS_ToastMessageType,
			);
		}
		else if (count > 0) {
			eda.sys_Message.showToastMessage(
				`已自适应重建 ${count} 个铺铜区域（${[...layers].join(', ')} 层）。`,
				'success' as ESYS_ToastMessageType,
			);
		}
	}
	catch (error) {
		console.error('[EDAMax Adaptive Pour] rebuild failed', error);
		eda.sys_Message.showToastMessage(
			`智能铺铜失败：${String(error)}`,
			'error' as ESYS_ToastMessageType,
		);
	}
	finally {
		rebuildRunning = false;
		if (pendingLayers.size > 0) await drainRebuildQueue();
	}
}

function scheduleRebuild(layers: readonly number[]): void {
	for (const layer of layers) pendingLayers.add(layer);
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => void drainRebuildQueue(), DEBOUNCE_MS);
}

async function handlePadModification(_eventType: unknown, props: any): Promise<void> {
	if (!automaticRebuild || rebuildRunning) return;
	const records = Array.isArray(props) ? props : [props];
	for (const record of records) {
		if (!record?.primitiveId || !isPadPrimitiveType(record.primitiveType)) continue;
		const pad = await eda.pcb_PrimitivePad.get(record.primitiveId);
		if (pad) scheduleRebuild(await layersForPad(pad));
	}
}

export async function activate(): Promise<void> {
	try {
		automaticRebuild = (await eda.sys_Storage.getExtensionUserConfig(AUTO_CONFIG_KEY)) !== false;
	}
	catch {
		automaticRebuild = true;
	}
	if (!eda.pcb_Event.isEventListenerAlreadyExist(PAD_EVENT_LISTENER_ID)) {
		eda.pcb_Event.addPrimitiveEventListener(
			PAD_EVENT_LISTENER_ID,
			'modify' as EPCB_PrimitiveEventType,
			handlePadModification,
		);
	}
}

export async function rebuildAllCopper(): Promise<void> {
	const count = await eda.pcb_Layer.getTheNumberOfCopperLayers();
	scheduleRebuild(allCopperLayers(count));
	await drainRebuildQueue();
}

export async function toggleAutomaticRebuild(): Promise<void> {
	automaticRebuild = !automaticRebuild;
	await eda.sys_Storage.setExtensionUserConfig(AUTO_CONFIG_KEY, automaticRebuild);
	eda.sys_Message.showToastMessage(
		`焊盘移动自动重铺：${automaticRebuild ? '已开启' : '已关闭'}`,
		'info' as ESYS_ToastMessageType,
	);
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`EDAMax 多层自适应铺铜 v${extensionConfig.version}\n` +
		'移动 SMD 焊盘时刷新所属铜层；移动通孔焊盘时刷新全部有效铜层。\n' +
		'实际避让、热焊盘、孤岛和优先级由嘉立创原生铺铜内核计算。',
		'关于 EDAMax 智能铺铜',
	);
}
