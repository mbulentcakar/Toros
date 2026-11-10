/**
 * Grounder response scoring and element hit-testing — Toros slice AU0a.
 *
 * Converts a model's predicted image pixel coordinate to screen coordinates
 * (accounting for window rect and DPI), finds the deepest on-screen UIA element
 * whose bounding rectangle contains that screen point, and classifies the
 * outcome into one of:
 *   - `hit`
 *   - `wrong_element`
 *   - `harmless_miss`
 *   - `not_found`
 *   - `parse_error`
 *   - `transport_error`
 *   - `invalid_target`
 */

/**
 * Control types considered actionable for `wrong_element` classification.
 * Clicking an enabled control of one of these types when aiming at a different
 * target can trigger an unintended side effect.
 */
export const ACTIONABLE_CONTROL_TYPES = new Set([
  'Button',
  'MenuItem',
  'ListItem',
  'TabItem',
  'Hyperlink',
  'CheckBox',
  'RadioButton',
  'ComboBox',
  'Edit',
  'SplitButton',
]);

/** Strip an optional `ControlType.` prefix from a UIA control type name. */
export function normalizeControlType(controlType) {
  if (typeof controlType !== 'string') return '';
  return controlType.startsWith('ControlType.')
    ? controlType.slice('ControlType.'.length)
    : controlType;
}

/** Return true if the control type is in the AU0 actionable set. */
export function isActionableControlType(controlType) {
  return ACTIONABLE_CONTROL_TYPES.has(normalizeControlType(controlType));
}

/**
 * Normalize a rectangle object into `{ left, top, right, bottom, width, height }`.
 */
export function normalizeRect(rect) {
  if (typeof rect !== 'object' || rect === null) {
    throw new Error('Invalid rectangle: expected an object');
  }
  const left = Number(rect.left ?? rect.x ?? 0);
  const top = Number(rect.top ?? rect.y ?? 0);
  const width = rect.width !== undefined
    ? Number(rect.width)
    : Number(rect.right) - left;
  const height = rect.height !== undefined
    ? Number(rect.height)
    : Number(rect.bottom) - top;
  const right = rect.right !== undefined
    ? Number(rect.right)
    : left + width;
  const bottom = rect.bottom !== undefined
    ? Number(rect.bottom)
    : top + height;

  return { left, top, right, bottom, width, height };
}

/**
 * Convert an image pixel coordinate `{ x, y }` to physical screen coordinates
 * `{ x, y }` using `meta.window_rect`, `meta.dpi`, and optional `meta.image_size`.
 *
 * Rules:
 * - If `meta.image_size` is provided and its dimensions differ from `window_rect`
 *   (or `meta.logical_image` is not set and `image_size` matches physical capture),
 *   scale by `window_rect.width / image_size.width` and `window_rect.height / image_size.height`.
 * - If `meta.image_size` is omitted (or `meta.logical_image === true`), scale
 *   logical image pixels by `(meta.dpi ?? 96) / 96`.
 */
export function pixelToScreenPoint(point, meta) {
  if (
    typeof point !== 'object' ||
    point === null ||
    typeof point.x !== 'number' ||
    typeof point.y !== 'number' ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new Error('Invalid point: expected { x: number, y: number }');
  }
  if (typeof meta !== 'object' || meta === null || !meta.window_rect) {
    throw new Error('Invalid meta: expected an object with window_rect');
  }

  const winRect = normalizeRect(meta.window_rect);
  const dpi = Number(meta.dpi ?? 96) || 96;
  const dpiScale = dpi / 96;

  let scaleX = dpiScale;
  let scaleY = dpiScale;

  if (
    meta.image_size &&
    typeof meta.image_size.width === 'number' &&
    typeof meta.image_size.height === 'number' &&
    meta.image_size.width > 0 &&
    meta.image_size.height > 0 &&
    meta.logical_image !== true
  ) {
    scaleX = winRect.width / meta.image_size.width;
    scaleY = winRect.height / meta.image_size.height;
  }

  return {
    x: Math.round(winRect.left + point.x * scaleX),
    y: Math.round(winRect.top + point.y * scaleY),
  };
}

/**
 * Return true if `point` (`{ x, y }`) lies inside `rect` using half-open
 * intervals (`left <= x < right`, `top <= y < bottom`).
 */
export function rectContainsPoint(rect, point) {
  const r = normalizeRect(rect);
  if (r.width <= 0 || r.height <= 0 || r.right <= r.left || r.bottom <= r.top) {
    return false;
  }
  return (
    point.x >= r.left &&
    point.x < r.right &&
    point.y >= r.top &&
    point.y < r.bottom
  );
}

/**
 * Find the deepest on-screen element in `tree` whose `bounding_rect` contains
 * `screenPoint`. Offscreen elements (`is_offscreen: true`) are ignored.
 *
 * Depth is determined by `element.depth ?? element.selector.length`. When two
 * elements at the same depth both contain the point, the smaller bounding box
 * area wins; ties break in favor of the later element in tree order.
 */
export function findDeepestElementAtPoint(tree, screenPoint) {
  const elements = Array.isArray(tree)
    ? tree
    : (Array.isArray(tree?.elements) ? tree.elements : []);

  let bestElement = null;
  let bestDepth = -1;
  let bestArea = Infinity;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || typeof el !== 'object') continue;
    if (el.is_offscreen === true || el.offscreen === true) continue;
    if (!el.bounding_rect) continue;

    const r = normalizeRect(el.bounding_rect);
    if (!rectContainsPoint(r, screenPoint)) continue;

    const depth = typeof el.depth === 'number'
      ? el.depth
      : (Array.isArray(el.selector) ? el.selector.length : 0);
    const area = r.width * r.height;

    if (
      depth > bestDepth ||
      (depth === bestDepth && area <= bestArea)
    ) {
      bestElement = el;
      bestDepth = depth;
      bestArea = area;
    }
  }

  return bestElement;
}

/**
 * Compare two Spec V selector paths step-by-step.
 */
export function selectorsEqual(actualSelector, expectedSelector) {
  if (!Array.isArray(actualSelector) || !Array.isArray(expectedSelector)) {
    return false;
  }
  if (actualSelector.length === 0 || actualSelector.length !== expectedSelector.length) {
    return false;
  }
  for (let i = 0; i < actualSelector.length; i++) {
    const a = actualSelector[i];
    const b = expectedSelector[i];
    if (!a || !b) return false;
    if (normalizeControlType(a.control_type) !== normalizeControlType(b.control_type)) {
      return false;
    }
    if ((a.automation_id ?? null) !== (b.automation_id ?? null)) {
      return false;
    }
    if ((a.name ?? null) !== (b.name ?? null)) {
      return false;
    }
    if (Number(a.index ?? 0) !== Number(b.index ?? 0)) {
      return false;
    }
  }
  return true;
}

/**
 * Determine whether `element` matches the target's `expected` selector path.
 *
 * Uses exact full-path equality whenever `expected` exists verbatim in `tree`.
 * If no on-screen element in `tree` has the exact ancestor chain, falls back to
 * matching the leaf step's `control_type` and `automation_id` ONLY when the leaf's
 * `automation_id` is non-empty and unique among on-screen elements of that
 * control type. Never matches by `name` alone.
 */
export function matchesExpectedSelector(element, expectedSelector, treeElements = []) {
  if (!element || !Array.isArray(expectedSelector) || expectedSelector.length === 0) {
    return false;
  }
  if (element.is_offscreen === true || element.offscreen === true) {
    return false;
  }
  if (selectorsEqual(element.selector, expectedSelector)) {
    return true;
  }

  const onScreenElements = Array.isArray(treeElements)
    ? treeElements.filter((el) => el && el.is_offscreen !== true && el.offscreen !== true)
    : [];

  const exactExistsInTree = onScreenElements.some((el) => selectorsEqual(el.selector, expectedSelector));
  if (exactExistsInTree) {
    return false;
  }

  const leaf = expectedSelector[expectedSelector.length - 1];
  if (!leaf) return false;
  const leafType = normalizeControlType(leaf.control_type);
  if (normalizeControlType(element.control_type) !== leafType) {
    return false;
  }
  if (typeof leaf.automation_id !== 'string' || leaf.automation_id.length === 0) {
    return false;
  }
  if (element.automation_id !== leaf.automation_id) {
    return false;
  }

  if (onScreenElements.length > 0) {
    const matchingCount = onScreenElements.filter(
      (el) => normalizeControlType(el.control_type) === leafType && el.automation_id === leaf.automation_id,
    ).length;
    if (matchingCount !== 1) {
      return false;
    }
  }

  return true;
}

/**
 * Return true if the target's `expected` selector matches at least one on-screen
 * element in `tree` (either verbatim or via the unique-`automation_id` leaf fallback).
 */
export function targetExistsInTree(expectedOrTree, treeOrExpected) {
  let expectedSelector = expectedOrTree;
  let tree = treeOrExpected;
  if (
    Array.isArray(expectedOrTree) &&
    expectedOrTree.length > 0 &&
    expectedOrTree[0] &&
    expectedOrTree[0].selector !== undefined
  ) {
    tree = expectedOrTree;
    expectedSelector = treeOrExpected;
  }
  if (!Array.isArray(expectedSelector) || expectedSelector.length === 0) {
    return false;
  }
  const elements = Array.isArray(tree)
    ? tree
    : (Array.isArray(tree?.elements) ? tree.elements : []);
  return elements.some((el) => matchesExpectedSelector(el, expectedSelector, elements));
}

/**
 * Score a single parsed grounder response against a window's `tree.json`,
 * `meta.json`, and target `expected` selector.
 */
export function scoreResponse({ parsed, tree, expected, meta }) {
  const elements = Array.isArray(tree)
    ? tree
    : (Array.isArray(tree?.elements) ? tree.elements : []);

  if (!targetExistsInTree(expected, elements)) {
    return {
      classification: 'invalid_target',
      screen_point: null,
      element: null,
    };
  }

  if (parsed && typeof parsed === 'object' && parsed.status === 'transport_error') {
    return {
      classification: 'transport_error',
      screen_point: null,
      element: null,
    };
  }

  if (!parsed || typeof parsed !== 'object' || parsed.status === 'parse_error' || parsed.ok === false) {
    return {
      classification: 'parse_error',
      screen_point: null,
      element: null,
    };
  }

  if (parsed.status === 'not_found' || parsed.not_found === true) {
    return {
      classification: 'not_found',
      screen_point: null,
      element: null,
    };
  }

  const rawPoint = parsed.point ?? (
    typeof parsed.x === 'number' && typeof parsed.y === 'number'
      ? { x: parsed.x, y: parsed.y }
      : null
  );

  if (
    !rawPoint ||
    typeof rawPoint.x !== 'number' ||
    typeof rawPoint.y !== 'number' ||
    !Number.isFinite(rawPoint.x) ||
    !Number.isFinite(rawPoint.y)
  ) {
    return {
      classification: 'parse_error',
      screen_point: null,
      element: null,
    };
  }

  // Negative image coordinates or beyond image_size bounds are outside the window
  if (rawPoint.x < 0 || rawPoint.y < 0) {
    return {
      classification: 'not_found',
      screen_point: null,
      element: null,
    };
  }
  if (
    meta?.image_size &&
    typeof meta.image_size.width === 'number' &&
    typeof meta.image_size.height === 'number' &&
    meta.image_size.width > 0 &&
    meta.image_size.height > 0 &&
    (rawPoint.x >= meta.image_size.width || rawPoint.y >= meta.image_size.height)
  ) {
    return {
      classification: 'not_found',
      screen_point: pixelToScreenPoint(rawPoint, meta),
      element: null,
    };
  }

  const screenPoint = pixelToScreenPoint(rawPoint, meta);
  const winRect = normalizeRect(meta.window_rect);

  if (!rectContainsPoint(winRect, screenPoint)) {
    return {
      classification: 'not_found',
      screen_point: screenPoint,
      element: null,
    };
  }

  const hitElement = findDeepestElementAtPoint(elements, screenPoint);

  if (!hitElement) {
    return {
      classification: 'harmless_miss',
      screen_point: screenPoint,
      element: null,
    };
  }

  if (matchesExpectedSelector(hitElement, expected, elements)) {
    return {
      classification: 'hit',
      screen_point: screenPoint,
      element: {
        control_type: hitElement.control_type,
        automation_id: hitElement.automation_id ?? null,
        name: hitElement.name ?? null,
        selector: hitElement.selector,
      },
    };
  }

  if (hitElement.enabled === true && isActionableControlType(hitElement.control_type)) {
    return {
      classification: 'wrong_element',
      screen_point: screenPoint,
      element: {
        control_type: hitElement.control_type,
        automation_id: hitElement.automation_id ?? null,
        name: hitElement.name ?? null,
        selector: hitElement.selector,
      },
    };
  }

  return {
    classification: 'harmless_miss',
    screen_point: screenPoint,
    element: {
      control_type: hitElement.control_type,
      automation_id: hitElement.automation_id ?? null,
      name: hitElement.name ?? null,
      selector: hitElement.selector,
    },
  };
}
