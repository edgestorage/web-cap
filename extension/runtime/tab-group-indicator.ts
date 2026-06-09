export interface TabGroupTargetTab {
  id: number;
  windowId?: number;
}

export interface TabGroupCreateOptions {
  tabIds: number | number[];
  createProperties?: {
    windowId?: number;
  };
}

export function createExecutionTabGroupOptions(tab: TabGroupTargetTab): TabGroupCreateOptions {
  return {
    tabIds: tab.id,
    ...(typeof tab.windowId === 'number' && tab.windowId >= 0
      ? { createProperties: { windowId: tab.windowId } }
      : {}),
  };
}
