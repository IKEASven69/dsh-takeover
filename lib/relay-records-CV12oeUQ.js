//#region src/relay-records.ts
/** 记录类型（plugin record 文法：plugin: 后跟小写斜杠分段） */
const RELAY_RECORD_TYPE = {
	takeover: "plugin:dsh-takeover/takeover",
	take_deposit: "plugin:dsh-takeover/take-deposit",
	pickup: "plugin:dsh-takeover/pickup"
};
/** 尽力追加接力溯源记录：API 缺席（旧宿主）/任何失败 → false，调用方不感知 */
async function appendRelayRecord(session, kind, data) {
	try {
		const mod = await import("@deepseek-ai/dsh-session");
		if (typeof mod.appendPluginRecord !== "function") return false;
		mod.appendPluginRecord(session, RELAY_RECORD_TYPE[kind], { ...data });
		return true;
	} catch {
		return false;
	}
}
//#endregion
export { appendRelayRecord };

//# sourceMappingURL=relay-records-CV12oeUQ.js.map