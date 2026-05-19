/* eslint-disable */
// Mechanically extracted from script-runtime.injected.ts. Keep behavior changes out of this file.
type Route = number[];

interface RenderedRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface RoundedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface VisibleItem {
  key: string;
  tag: string;
  id: string;
  class: string;
  text: string;
  rect: RoundedRect;
  merged?: boolean;
}

interface VisibleEntry {
  route: Route;
  routeKey: string;
  item: VisibleItem;
}

interface VisibleSnapshot {
  visibleSemanticEntries: VisibleEntry[];
  visibleElementEntries: VisibleEntry[];
  visibleSemanticEntryByRoute: Map<string, VisibleEntry>;
  visibleElementEntryByRoute: Map<string, VisibleEntry>;
}

interface ChangeRecord {
  kind: string;
  route: Route;
  attributeName: string | null;
}

interface DiffState {
  truncated: boolean;
}

interface UpdatedEntry {
  beforeRoute: Route;
  before: VisibleItem;
  after: VisibleItem;
}

export function captureVisibleElementsDiff() {
  if (typeof document === 'undefined') {
    return {
      start() {},
      stop() {
        return [];
      },
      snapshot() {
        return {};
      },
      snapshotForChanges() {
        return {};
      },
      diff() {
        return {
          added: [],
          removed: [],
          updated: [],
          truncated: false,
        };
      },
    };
  }

  const MAX_VISIBLE_ELEMENTS = 300;
  const MAX_TEXT_LENGTH = 80;
  const ROOT_REPRESENTATIVE_IDS = new Set(['app']);
  const IGNORED_ATTRIBUTE_NAMES = new Set(['class', 'style']);
  const VISIBILITY_ATTRIBUTE_NAMES = new Set(['class', 'style', 'hidden', 'open']);
  const OBSERVED_ATTRIBUTE_NAMES = [
    'class',
    'style',
    'hidden',
    'open',
    'src',
    'href',
    'value',
    'checked',
    'selected',
    'aria-hidden',
  ];
  const INTERACTIVE_TAGS = new Set([
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'img',
    'video',
    'label',
  ]);
  const CONTENT_TAGS = new Set([
    'span',
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'strong',
    'em',
  ]);
  const round = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);
  const routeKey = (route: Route) => route.join('.');
  const normalizeText = (value: unknown) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  const toRoundedRect = (rect: Pick<RenderedRect, 'left' | 'top' | 'width' | 'height'>) => ({
    x: round(rect.left),
    y: round(rect.top),
    w: round(rect.width),
    h: round(rect.height),
  });
  const getOwnRenderedRect = (element: unknown): RenderedRect | null => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const mergeRenderedRects = (
    current: RenderedRect | null,
    next: RenderedRect | null,
  ): RenderedRect | null => {
    if (!current) {
      return next;
    }
    if (!next) {
      return current;
    }
    const left = Math.min(current.left, next.left);
    const top = Math.min(current.top, next.top);
    const right = Math.max(current.right, next.right);
    const bottom = Math.max(current.bottom, next.bottom);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  };
  const isStyleHidden = (element: unknown) => {
    if (!(element instanceof HTMLElement)) {
      return true;
    }
    const style = globalThis.getComputedStyle?.(element);
    if (!style) {
      return true;
    }
    return (
      element.hidden ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    );
  };
  const isRepresentativeElement = (element: unknown) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'html' || tagName === 'body') {
      return false;
    }
    if (ROOT_REPRESENTATIVE_IDS.has(element.id || '')) {
      return false;
    }
    return true;
  };
  const isVisible = (element: unknown, hasRenderedBox: (element: HTMLElement) => boolean) => {
    if (!(element instanceof HTMLElement) || !hasRenderedBox(element)) {
      return false;
    }
    if (!isRepresentativeElement(element)) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tagName)) {
      return true;
    }

    const role = element.getAttribute('role') || '';
    if (role === 'button' || role === 'link' || role === 'dialog' || role === 'menuitem') {
      return true;
    }

    const text = normalizeText(element.textContent);
    if (!text) {
      return false;
    }

    if (CONTENT_TAGS.has(tagName)) {
      return true;
    }

    const visibleChildren = [...element.children].filter((child) =>
      child instanceof HTMLElement ? hasRenderedBox(child) : false,
    );
    return visibleChildren.length === 0;
  };
  const shouldIgnoreAttributeChange = (attributeName: string | null) => {
    if (!attributeName) {
      return false;
    }
    const normalized = String(attributeName).toLowerCase();
    return IGNORED_ATTRIBUTE_NAMES.has(normalized) || normalized.startsWith('data-');
  };
  const stableSegment = (element: HTMLElement) => {
    const tagName = element.tagName.toLowerCase();
    if (element.id) {
      return tagName + '#' + element.id;
    }
    const siblings = element.parentElement
      ? [...element.parentElement.children].filter(
          (candidate) => candidate.tagName === element.tagName,
        )
      : [];
    const index = siblings.length > 1 ? siblings.indexOf(element) + 1 : 0;
    return tagName + (index > 0 ? ':nth-of-type(' + index + ')' : '');
  };
  const stableKey = (element: HTMLElement) => {
    const path: string[] = [];
    let current: HTMLElement | null = element;
    let depth = 0;
    while (current && depth < 5) {
      path.unshift(stableSegment(current));
      current = current.parentElement;
      depth += 1;
    }

    const extras = [];
    const href = element.getAttribute('href');
    const src = element.getAttribute('src');
    const role = element.getAttribute('role');
    const name = element.getAttribute('name');
    const type = element.getAttribute('type');
    if (href) extras.push('href=' + href);
    if (src) extras.push('src=' + src);
    if (role) extras.push('role=' + role);
    if (name) extras.push('name=' + name);
    if (type) extras.push('type=' + type);

    return path.join(' > ') + (extras.length > 0 ? ' [' + extras.join(',') + ']' : '');
  };
  const describe = (element: HTMLElement, renderedRect: RenderedRect | null): VisibleItem => {
    const fallbackRect = element.getBoundingClientRect();
    const rect = renderedRect ?? {
      left: fallbackRect.left,
      top: fallbackRect.top,
      width: fallbackRect.width,
      height: fallbackRect.height,
    };
    return {
      key: stableKey(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      class: element.className || '',
      text: normalizeText(element.textContent),
      rect: toRoundedRect(rect),
    };
  };
  const collectVisibleEntries = (rootNode: Node, baseRoute: Route = []) => {
    const renderedRectByElement = new WeakMap<HTMLElement, RenderedRect>();
    const fallbackRenderedRectByElement = new WeakMap<HTMLElement, RenderedRect>();
    const collectRenderedRects = (
      node: Node,
      ancestorHidden = false,
    ): RenderedRect | null => {
      if (!(node instanceof HTMLElement)) {
        const childNodes = node?.childNodes ? [...node.childNodes] : [];
        let childRect: RenderedRect | null = null;
        childNodes.forEach((child) => {
          childRect = mergeRenderedRects(childRect, collectRenderedRects(child, ancestorHidden));
        });
        return childRect;
      }

      const hidden = ancestorHidden || isStyleHidden(node);
      if (hidden) {
        return null;
      }

      const ownRect = getOwnRenderedRect(node);
      let subtreeRect = ownRect;
      if (ownRect) {
        renderedRectByElement.set(node, ownRect);
      }
      const childNodes = node.childNodes ? [...node.childNodes] : [];
      childNodes.forEach((child) => {
        subtreeRect = mergeRenderedRects(subtreeRect, collectRenderedRects(child, hidden));
      });
      if (!ownRect && subtreeRect) {
        fallbackRenderedRectByElement.set(node, subtreeRect);
      }
      return subtreeRect;
    };
    collectRenderedRects(rootNode);

      const resolveRenderedRect = (element: HTMLElement) =>
        renderedRectByElement.get(element) ?? fallbackRenderedRectByElement.get(element) ?? null;
    const hasRenderedBox = (element: HTMLElement) => resolveRenderedRect(element) !== null;
    const semanticEntries: VisibleEntry[] = [];
    const elementEntries: VisibleEntry[] = [];
    const visit = (node: Node, route: Route) => {
      if (node instanceof HTMLElement && hasRenderedBox(node) && isRepresentativeElement(node)) {
        const renderedRect = resolveRenderedRect(node);
        const entry = {
          route,
          routeKey: routeKey(route),
          item: describe(node, renderedRect),
        };
        elementEntries.push(entry);
        if (isVisible(node, hasRenderedBox)) {
          semanticEntries.push(entry);
        }
      }

      const childNodes = node?.childNodes ? [...node.childNodes] : [];
      childNodes.forEach((child, index) => {
        visit(child, route.concat(index));
      });
    };

    visit(rootNode, baseRoute);
    return {
      semanticEntries,
      elementEntries,
    };
  };
  const routeFromNode = (rootNode: Node, node: Node | null): Route | null => {
    if (!node) {
      return null;
    }
    if (node === rootNode) {
      return [];
    }

    const route: Route = [];
    let current = node;
    while (current && current !== rootNode) {
      const parent = current.parentNode;
      if (!parent) {
        return null;
      }
      const index = [...parent.childNodes].indexOf(current as ChildNode);
      if (index < 0) {
        return null;
      }
      route.unshift(index);
      current = parent;
    }

    return current === rootNode ? route : null;
  };
  const nodeFromRoute = (rootNode: Node, route: Route): Node | null => {
    let current = rootNode;
    for (const index of route) {
      if (!current?.childNodes || index < 0 || index >= current.childNodes.length) {
        return null;
      }
      current = current.childNodes[index];
    }
    return current;
  };
  const pickBestEntry = (entries: VisibleEntry[]): VisibleEntry | null => {
    if (!entries || entries.length === 0) {
      return null;
    }
    return entries.reduce<VisibleEntry | null>((best, candidate) => {
      if (!best) {
        return candidate;
      }
      if (candidate.route.length !== best.route.length) {
        return candidate.route.length < best.route.length ? candidate : best;
      }
      const bestArea = best.item.rect.w * best.item.rect.h;
      const candidateArea = candidate.item.rect.w * candidate.item.rect.h;
      return candidateArea > bestArea ? candidate : best;
    }, null);
  };
  const hasRoutePrefix = (candidate: Route, prefix: Route) => {
    if (prefix.length > candidate.length) {
      return false;
    }
    for (let index = 0; index < prefix.length; index += 1) {
      if (candidate[index] !== prefix[index]) {
        return false;
      }
    }
    return true;
  };
  const visibleItemsAtRoute = (
    snapshot: VisibleSnapshot,
    route: Route,
    mode: 'parent' | 'subtree' | 'exact',
  ): VisibleEntry[] => {
    const targetRoute = mode === 'parent' ? route.slice(0, -1) : route;
    if (mode === 'subtree') {
      const subtreeEntries = snapshot.visibleElementEntries.filter((entry) =>
        hasRoutePrefix(entry.route, targetRoute),
      );
      const bestSubtreeEntry = pickBestEntry(subtreeEntries);
      if (bestSubtreeEntry) {
        return [bestSubtreeEntry];
      }
      for (let depth = targetRoute.length; depth >= 0; depth -= 1) {
        const ancestor = snapshot.visibleElementEntryByRoute.get(
          routeKey(targetRoute.slice(0, depth)),
        );
        if (ancestor) {
          return [ancestor];
        }
      }
      return [];
    }

    const exact = snapshot.visibleSemanticEntryByRoute.get(routeKey(targetRoute));
    if (exact) {
      return [exact];
    }
    for (let depth = targetRoute.length - 1; depth >= 0; depth -= 1) {
      const ancestor = snapshot.visibleSemanticEntryByRoute.get(routeKey(targetRoute.slice(0, depth)));
      if (ancestor) {
        return [ancestor];
      }
    }
    return [];
  };
  const didItemMateriallyChange = (beforeItem: VisibleItem, afterItem: VisibleItem) =>
    beforeItem.text !== afterItem.text ||
    beforeItem.tag !== afterItem.tag ||
    beforeItem.id !== afterItem.id ||
    beforeItem.key !== afterItem.key;
  const appendUnique = (
    target: VisibleEntry[],
    seenKeys: Set<string>,
    entries: VisibleEntry[],
    state: DiffState,
  ) => {
    for (const entry of entries) {
      if (target.some((existing) => hasRoutePrefix(entry.route, existing.route))) {
        continue;
      }

      for (let index = target.length - 1; index >= 0; index -= 1) {
        if (hasRoutePrefix(target[index].route, entry.route)) {
          seenKeys.delete(target[index].item.key);
          target.splice(index, 1);
        }
      }

      if (seenKeys.has(entry.item.key)) {
        continue;
      }
      if (target.length >= MAX_VISIBLE_ELEMENTS) {
        state.truncated = true;
        break;
      }
      seenKeys.add(entry.item.key);
      target.push(entry);
    }
  };
  const mergeEntriesForRoute = (entries: VisibleEntry[], targetRoute: Route): VisibleEntry => {
    const targetKey = routeKey(targetRoute);
    const parentNode = nodeFromRoute(rootNode, targetRoute);
    const parentClassName =
      parentNode instanceof HTMLElement ? String(parentNode.className || '') : '';
    const parentStableKey =
      parentNode instanceof HTMLElement ? stableKey(parentNode) : targetKey;
    const texts = entries
      .map((item) => item.item.text)
      .filter(Boolean)
      .filter((text, index, all) => all.indexOf(text) === index);
    const rect = entries.reduce(
      (box: { left: number; top: number; right: number; bottom: number }, item) => {
        const left = item.item.rect.x;
        const top = item.item.rect.y;
        const right = left + item.item.rect.w;
        const bottom = top + item.item.rect.h;
        return {
          left: Math.min(box.left, left),
          top: Math.min(box.top, top),
          right: Math.max(box.right, right),
          bottom: Math.max(box.bottom, bottom),
        };
      },
      {
        left: entries[0].item.rect.x,
        top: entries[0].item.rect.y,
        right: entries[0].item.rect.x + entries[0].item.rect.w,
        bottom: entries[0].item.rect.y + entries[0].item.rect.h,
      },
    );
    return {
      route: targetRoute,
      routeKey: targetKey,
      item: {
        key: 'merged:' + parentStableKey,
        tag: 'group',
        id: '',
        class: parentClassName,
        merged: true,
        text: normalizeText(texts.join(' | ')),
        rect: {
          x: round(rect.left),
          y: round(rect.top),
          w: round(rect.right - rect.left),
          h: round(rect.bottom - rect.top),
        },
      },
    };
  };
  const mergeSiblingEntries = (entries: VisibleEntry[]) => {
    const remaining = [...entries];
    const merged: VisibleEntry[] = [];

    while (remaining.length > 0) {
      const seed = remaining.shift();
      if (!seed) {
        break;
      }

        let bestRoute: Route | null = null;
        let bestGroup: VisibleEntry[] | null = null;
      for (let depth = seed.route.length - 1; depth >= 1; depth -= 1) {
        const candidateRoute = seed.route.slice(0, depth);
        const candidateGroup = [seed, ...remaining.filter((entry) => hasRoutePrefix(entry.route, candidateRoute))];
        const distinctChildren = new Set(
          candidateGroup
            .filter((entry) => entry.route.length > candidateRoute.length)
            .map((entry) => entry.route[candidateRoute.length]),
        );
        if (distinctChildren.size > 3) {
          bestRoute = candidateRoute;
          bestGroup = candidateGroup;
          break;
        }
      }

      if (!bestRoute || !bestGroup) {
        merged.push(seed);
        continue;
      }

      merged.push(mergeEntriesForRoute(bestGroup, bestRoute));
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (hasRoutePrefix(remaining[index].route, bestRoute)) {
          remaining.splice(index, 1);
        }
      }
    }

    return merged;
  };
  const rootNode = document.body;
  const changedRecords: ChangeRecord[] = [];
  let observer: MutationObserver | null = null;
  const toSnapshot = (
    semanticEntries: VisibleEntry[],
    elementEntries: VisibleEntry[],
  ): VisibleSnapshot => ({
    visibleSemanticEntries: semanticEntries,
    visibleElementEntries: elementEntries,
    visibleSemanticEntryByRoute: new Map(
      semanticEntries.map((entry) => [entry.routeKey, entry]),
    ),
    visibleElementEntryByRoute: new Map(
      elementEntries.map((entry) => [entry.routeKey, entry]),
    ),
  });
  const normalizedChangeRecords = (changeRecords: ChangeRecord[]) => {
    const normalizedChanges: ChangeRecord[] = [];
    const seenChanges = new Set<string>();
    for (const change of changeRecords) {
      const route = Array.isArray(change.route) ? change.route : [];
      const attributeName = change.attributeName || '';
      if (change.kind === 'attribute' && shouldIgnoreAttributeChange(attributeName)) {
        continue;
      }
      const marker = change.kind + ':' + routeKey(route) + ':' + attributeName;
      if (seenChanges.has(marker)) {
        continue;
      }
      seenChanges.add(marker);
      normalizedChanges.push({
        kind: change.kind,
        route,
        attributeName,
      });
    }
    return normalizedChanges;
  };
  const addLocalSnapshotRoute = (routes: Route[], route: Route) => {
    if (routes.some((existing) => hasRoutePrefix(route, existing))) {
      return;
    }
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      if (hasRoutePrefix(routes[index], route)) {
        routes.splice(index, 1);
      }
    }
    routes.push(route);
  };
  const snapshot = () => {
    const { semanticEntries, elementEntries } = collectVisibleEntries(rootNode);
    return toSnapshot(semanticEntries, elementEntries);
  };
  const snapshotForChanges = (changeRecords: ChangeRecord[] = changedRecords) => {
    const routes: Route[] = [];
    for (const change of normalizedChangeRecords(changeRecords)) {
      if (change.kind === 'text') {
        addLocalSnapshotRoute(routes, change.route.slice(0, -1));
        continue;
      }
      addLocalSnapshotRoute(routes, change.route);
    }

    const semanticEntries: VisibleEntry[] = [];
    const elementEntries: VisibleEntry[] = [];
    const seenSemanticRoutes = new Set<string>();
    const seenElementRoutes = new Set<string>();
    for (const route of routes) {
      const node = nodeFromRoute(rootNode, route);
      if (!node) {
        continue;
      }
      const localEntries = collectVisibleEntries(node, route);
      for (const entry of localEntries.semanticEntries) {
        if (!seenSemanticRoutes.has(entry.routeKey)) {
          seenSemanticRoutes.add(entry.routeKey);
          semanticEntries.push(entry);
        }
      }
      for (const entry of localEntries.elementEntries) {
        if (!seenElementRoutes.has(entry.routeKey)) {
          seenElementRoutes.add(entry.routeKey);
          elementEntries.push(entry);
        }
      }
    }

    return toSnapshot(semanticEntries, elementEntries);
  };
  const recordChange = (kind: string, route: Route | null, attributeName: string | null = null) => {
    if (!route) {
      return;
    }
    changedRecords.push({
      kind,
      route,
      attributeName: attributeName || null,
    });
  };
  const start = () => {
    changedRecords.length = 0;
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    observer?.disconnect?.();
    observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'childList') {
          recordChange('structure', routeFromNode(rootNode, record.target));
          return;
        }
        if (record.type === 'characterData') {
          recordChange('text', routeFromNode(rootNode, record.target?.parentNode));
          return;
        }
        if (record.type === 'attributes') {
          const attributeName = record.attributeName || '';
          const kind = VISIBILITY_ATTRIBUTE_NAMES.has(attributeName) ? 'visibility' : 'attribute';
          recordChange(kind, routeFromNode(rootNode, record.target), attributeName);
        }
      });
    });
    observer.observe(rootNode, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: OBSERVED_ATTRIBUTE_NAMES,
    });
  };
  const stop = () => {
    observer?.disconnect?.();
    observer = null;
    return changedRecords.slice();
  };

  return {
    start,
    stop,
    snapshot,
    snapshotForChanges,
    diff(
      beforeSnapshot: VisibleSnapshot,
      afterSnapshot: VisibleSnapshot,
      changeRecords: ChangeRecord[] = changedRecords,
    ) {
      const added: VisibleEntry[] = [];
      const removed: VisibleEntry[] = [];
      const updated: UpdatedEntry[] = [];
      const addedKeys = new Set<string>();
      const removedKeys = new Set<string>();
      const updatedKeys = new Set<string>();
      const state = { truncated: false };
      const appendUpdated = (beforeEntries: VisibleEntry[], afterEntries: VisibleEntry[]) => {
        for (const beforeEntry of beforeEntries) {
          const afterEntry = afterEntries.find((candidate) => candidate.item.key === beforeEntry.item.key);
          if (!afterEntry) {
            continue;
          }
          if (updatedKeys.has(beforeEntry.item.key)) {
            continue;
          }
          if (
            updated.some(
              (existing) =>
                hasRoutePrefix(beforeEntry.route, existing.beforeRoute) ||
                hasRoutePrefix(existing.beforeRoute, beforeEntry.route),
            )
          ) {
            continue;
          }
          for (let index = updated.length - 1; index >= 0; index -= 1) {
            if (hasRoutePrefix(updated[index].beforeRoute, beforeEntry.route)) {
              updatedKeys.delete((updated[index].before as any).item.key);
              updated.splice(index, 1);
            }
          }
          if (updated.length >= MAX_VISIBLE_ELEMENTS) {
            state.truncated = true;
            break;
          }
          updatedKeys.add(beforeEntry.item.key);
          updated.push({
            beforeRoute: beforeEntry.route,
            before: beforeEntry.item,
            after: afterEntry.item,
          });
        }
      };

      const normalizedChanges = normalizedChangeRecords(changeRecords);

      for (const change of normalizedChanges) {
        const beforeEntries =
          change.kind === 'structure' || change.kind === 'visibility'
            ? visibleItemsAtRoute(beforeSnapshot, change.route, 'subtree')
            : visibleItemsAtRoute(
                beforeSnapshot,
                change.route,
                change.kind === 'text' ? 'parent' : 'exact',
              );
        const afterEntries =
          change.kind === 'structure' || change.kind === 'visibility'
            ? visibleItemsAtRoute(afterSnapshot, change.route, 'subtree')
            : visibleItemsAtRoute(
                afterSnapshot,
                change.route,
                change.kind === 'text' ? 'parent' : 'exact',
              );

        if (beforeEntries.length === 0 && afterEntries.length === 0) {
          continue;
        }
        if (beforeEntries.length === 0) {
          appendUnique(added, addedKeys, afterEntries, state);
          continue;
        }
        if (afterEntries.length === 0) {
          appendUnique(removed, removedKeys, beforeEntries, state);
          continue;
        }

        const beforeEntry = beforeEntries[0];
        const afterEntry = afterEntries[0];
        if (beforeEntry.item.key !== afterEntry.item.key) {
          appendUnique(removed, removedKeys, [beforeEntry], state);
          appendUnique(added, addedKeys, [afterEntry], state);
          continue;
        }

        if (
          change.kind !== 'visibility' &&
          didItemMateriallyChange(beforeEntry.item, afterEntry.item)
        ) {
          appendUpdated([beforeEntry], [afterEntry]);
          continue;
        }
      }

      const mergedAdded = mergeSiblingEntries(added);
      const mergedRemoved = mergeSiblingEntries(removed);

      return {
        truncated: state.truncated,
        added: mergedAdded.map((entry) => entry.item),
        removed: mergedRemoved.map((entry) => entry.item),
        updated: updated.map((entry) => ({
          before: entry.before,
          after: entry.after,
        })),
      };
    },
  };
}
