/* eslint-disable */
import type { Locator as PlaywrightLocator, Page as PlaywrightPage } from 'playwright-core';

export type RuntimeMethodTable = Record<string, any>;
export type ScriptPlaywrightPage = RuntimeMethodTable & { __playwrightPageType?: PlaywrightPage };
export type ScriptPlaywrightLocator = RuntimeMethodTable & { __playwrightLocatorType?: PlaywrightLocator };
export type LocatorQuery = () => Element[];

export type PlaywrightShimDeps = {
  wait(ms: number): Promise<unknown>;
  typeIntoElement(element: unknown, value: unknown): Promise<void>;
  isEditableElement(element: unknown): boolean;
  useDomKeyboardFallback(): boolean;
  browserCommand?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  browserEvent?(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  recordEvidenceEvent?(type: string, value: unknown): void;
  waitForManagedInput(): Promise<void>;
};
