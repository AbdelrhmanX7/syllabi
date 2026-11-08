import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActiveSelection, Circle, Ellipse, FabricImage, Group, Path, Point, Rect } from 'fabric';

import type { FabricObject } from 'fabric';

import { pointInPolygon } from './eraserGeometry';
import { lassoPolygon } from './selectionClipboard';
import {
  INSIDE_FRACTION,
  installGeometryTargetFind,
  isStrokeLike,
  objectHitsTap,
  objectInsidePolygon,
  objectsInsidePolygon,
  objectTapDistance,
  pickTapTarget,
  SELECTED_GRAB_FACTOR,
  selectionGrabbedByPaint,
  setSelectionGrabsByPaint,
  strokeGeometryOf,
  strokeSamples,
  tapTolerancePx,
} from './selectionHitTest';

// What the pen brush produces: an open path, stroked, never filled.
const strokePath = (d: string, strokeWidth = 4) => new Path(d, { fill: null, stroke: 'navy', strokeWidth, strokeLineCap: 'round' });

// A closed loop of n points around a rectangle, like a lasso drawn around it.
const loopAround = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top },
  { x: (left + right) / 2, y: top - 2 },
  { x: right, y: top },
  { x: right + 2, y: (top + bottom) / 2 },
  { x: right, y: bottom },
  { x: (left + right) / 2, y: bottom + 2 },
  { x: left, y: bottom },
  { x: left - 2, y: (top + bottom) / 2 },
];

describe('tapTolerancePx', () => {
  it('gives a finger more reach than a pen, and a mouse the least', () => {
    assert.ok(tapTolerancePx('touch') > tapTolerancePx('pen'));
    assert.ok(tapTolerancePx('pen') > tapTolerancePx('mouse'));
    assert.equal(tapTolerancePx(undefined), tapTolerancePx('mouse'));
  });
});

describe('strokeGeometryOf', () => {
  it('reduces a path to its scene polyline and half its stroke width', () => {
    const path = strokePath('M 0 0 L 100 0', 6);
    const geometry = strokeGeometryOf(path)!;

    assert.equal(geometry.halfStroke, 3);
    assert.equal(geometry.filled, false);
    assert.equal(geometry.polylines.length, 1);
    assert.deepEqual(geometry.bounds, { left: 0, top: 0, right: 100, bottom: 0 });
  });

  it('is null for things that paint their box, and an outline for shapes', () => {
    const card = new Group([new Rect({ width: 10, height: 10, fill: 'gold' })]);

    assert.equal(strokeGeometryOf(card), null);
    assert.equal(isStrokeLike(card), false);
    assert.equal(isStrokeLike(strokePath('M 0 0 L 1 1')), true);
    assert.equal(isStrokeLike(new Rect({ width: 10, height: 10 })), true);

    const rect = new Rect({ left: 0, top: 0, width: 10, height: 20, fill: 'transparent', stroke: 'navy', strokeWidth: 2 });
    const outline = strokeGeometryOf(rect)!;

    assert.equal(outline.closed, true);
    assert.equal(outline.filled, false);
    assert.equal(outline.polylines[0]!.length, 4);
  });

  it('does not rebuild an unchanged stroke (the hover path): same geometry object back', () => {
    const path = strokePath('M 0 0 C 10 10 20 10 30 0 L 60 0');
    const first = strokeGeometryOf(path);

    for (let i = 0; i < 5; i += 1) assert.equal(strokeGeometryOf(path), first);
  });

  it('serves the cache until the object moves, then follows it', () => {
    const path = strokePath('M 0 0 L 100 0');
    const first = strokeGeometryOf(path);

    assert.equal(strokeGeometryOf(path), first, 'same object, same place: cached');

    path.set({ left: path.left + 50 });
    path.setCoords();

    const moved = strokeGeometryOf(path)!;

    assert.notEqual(moved, first);
    assert.equal(moved.bounds.left, 50);
    assert.equal(moved.bounds.right, 150);
  });
});

describe('objectHitsTap — a stroke is hit on its ink, not in its box', () => {
  it('ignores a tap in the empty interior of a curve', () => {
    // A wide U: the box spans 0..100 × 0..100, the ink runs down the sides and along the bottom.
    const curve = strokePath('M 0 0 L 0 100 L 100 100 L 100 0');

    assert.equal(objectHitsTap(curve, { x: 50, y: 30 }, 10), false, 'empty middle of the box');
    assert.equal(objectHitsTap(curve, { x: 50, y: 100 }, 10), true, 'on the bottom edge');
    assert.equal(objectHitsTap(curve, { x: 0, y: 50 }, 10), true, 'on the left side');
  });

  it('reaches the ink within the tolerance plus half the stroke width, no further', () => {
    const path = strokePath('M 0 0 L 100 0', 4);

    assert.equal(objectHitsTap(path, { x: 50, y: 11.9 }, 10), true, 'within 10 + 2');
    assert.equal(objectHitsTap(path, { x: 50, y: 12.1 }, 10), false, 'past 10 + 2');
    assert.equal(objectHitsTap(path, { x: -11.9, y: 0 }, 10), true, 'just off the end');
  });

  it('counts the inside of a filled path (the brush nib outline, a snapped shape) as paint', () => {
    const blob = new Path('M 0 0 L 40 0 L 40 20 L 0 20 Z', { fill: 'navy', stroke: '', strokeWidth: 0 });

    assert.equal(objectHitsTap(blob, { x: 20, y: 10 }, 2), true, 'inside');
    assert.equal(objectHitsTap(blob, { x: 60, y: 10 }, 2), false, 'outside');
  });

  it('tests a filled shape by its box, as it paints it', () => {
    const rect = new Rect({ left: 0, top: 0, width: 50, height: 50, fill: 'navy' });

    rect.setCoords();
    assert.equal(objectHitsTap(rect, { x: 25, y: 25 }, 0), true);
    assert.equal(objectHitsTap(rect, { x: 80, y: 25 }, 0), false);
  });

  it('tests a path-only group (a traced word) by the ink of its children', () => {
    const word = new Group([strokePath('M 0 0 L 0 40'), strokePath('M 60 0 L 60 40')]);

    word.setCoords();

    const { left, top } = word.getBoundingRect();

    assert.equal(objectHitsTap(word, { x: left + 2, y: top + 20 }, 4), true, 'on the first letter');
    assert.equal(objectHitsTap(word, { x: left + 31, y: top + 20 }, 4), false, 'the gap between the letters');
  });
});

describe('pickTapTarget — the topmost stroke whose ink is under the pen', () => {
  it('picks only the stroke that was tapped when two boxes overlap', () => {
    // Two diagonals forming an X share the same box; a tap on one arm is far from the other.
    const rising = strokePath('M 0 100 L 100 0');
    const falling = strokePath('M 0 0 L 100 100');

    assert.equal(pickTapTarget([rising, falling], { x: 25, y: 75 }, 6), rising, 'the rising arm');
    assert.equal(pickTapTarget([rising, falling], { x: 25, y: 25 }, 6), falling, 'the falling arm');
    assert.equal(pickTapTarget([rising, falling], { x: 25, y: 50 }, 6), undefined, 'between the arms: nothing');
  });

  it('prefers the stroke on top where both are under the pen', () => {
    const under = strokePath('M 0 0 L 100 0');
    const over = strokePath('M 0 0 L 100 0');

    assert.equal(pickTapTarget([under, over], { x: 50, y: 0 }, 4), over);
  });

  it('skips hidden and non-evented objects like Fabric does', () => {
    const hidden = strokePath('M 0 0 L 100 0');
    const inert = strokePath('M 0 0 L 100 0');
    const live = strokePath('M 0 0 L 100 0');

    hidden.visible = false;
    inert.evented = false;

    assert.equal(pickTapTarget([live, inert, hidden], { x: 50, y: 0 }, 4), live);
  });
});

describe('strokeSamples', () => {
  it('spaces samples along the ink and keeps both ends', () => {
    const samples = strokeSamples(strokeGeometryOf(strokePath('M 0 0 L 100 0'))!);

    const xy = (p: { x: number; y: number }) => ({ x: p.x, y: p.y });

    assert.ok(samples.length >= 20 && samples.length <= 30, `evenly along 100px: got ${samples.length}`);
    assert.deepEqual(xy(samples[0]!), { x: 0, y: 0 });
    assert.deepEqual(xy(samples[samples.length - 1]!), { x: 100, y: 0 });
  });

  it('caps a very long stroke rather than sampling it endlessly', () => {
    const samples = strokeSamples(strokeGeometryOf(strokePath('M 0 0 L 100000 0'))!);

    assert.ok(samples.length <= 202, `capped: got ${samples.length}`);
  });

  it('a dot is its one point', () => {
    const path = new Path('M 5 5', { stroke: 'navy', strokeWidth: 4, fill: null });
    const samples = strokeSamples(strokeGeometryOf(path)!);

    assert.equal(samples.length, 1);
  });
});

describe('objectInsidePolygon — a lasso takes a stroke when most of its ink is inside', () => {
  it('takes the word inside the loop, not the long stroke crossing it', () => {
    // "Word": three short vertical strokes between x = 40 … 80; an underline-like stroke runs 0 … 300 under them.
    const letters = [strokePath('M 40 0 L 40 30'), strokePath('M 60 0 L 60 30'), strokePath('M 80 0 L 80 30')];
    const longStroke = strokePath('M 0 35 L 300 35');
    const loop = loopAround(30, -10, 90, 45);
    const polygon = lassoPolygon(loop);
    const picked = objectsInsidePolygon([...letters, longStroke], polygon);

    assert.deepEqual(picked, letters, 'the letters, and only the letters');
    assert.equal(objectInsidePolygon(longStroke, polygon), false, 'the long stroke: its box crosses the loop, its ink is mostly outside');
  });

  it('judges a stroke by the share of its ink inside', () => {
    const stroke = strokePath('M 0 0 L 100 0');

    // A loop over the right 70% of the stroke.
    assert.equal(objectInsidePolygon(stroke, lassoPolygon(loopAround(30, -10, 110, 10))), true);
    // A loop over the right 40%: not most of it.
    assert.equal(objectInsidePolygon(stroke, lassoPolygon(loopAround(60, -10, 110, 10))), false);
    assert.ok(INSIDE_FRACTION > 0.4 && INSIDE_FRACTION <= 0.7);
  });

  it('a box is the same rule with four corners', () => {
    const stroke = strokePath('M 0 0 L 100 0');
    const box = [
      { x: 20, y: -10 },
      { x: 110, y: -10 },
      { x: 110, y: 10 },
      { x: 20, y: 10 },
    ];
    const corner = [
      { x: 90, y: -10 },
      { x: 110, y: -10 },
      { x: 110, y: 10 },
      { x: 90, y: 10 },
    ];

    assert.equal(objectInsidePolygon(stroke, box), true);
    assert.equal(objectInsidePolygon(stroke, corner), false, 'a box over one end only touches, it does not take');
  });

  it('keeps the box rule for a filled shape and takes a traced word by all its strokes together', () => {
    const rect = new Rect({ left: 10, top: 10, width: 40, height: 40, fill: 'navy' });
    const word = new Group([strokePath('M 0 0 L 0 30'), strokePath('M 20 0 L 20 30'), strokePath('M 40 0 L 40 30')]);

    rect.setCoords();
    word.setCoords();

    assert.equal(objectInsidePolygon(rect, lassoPolygon(loopAround(0, 0, 60, 60))), true);
    assert.equal(objectInsidePolygon(rect, lassoPolygon(loopAround(45, 45, 100, 100))), false, 'one corner of the rect');

    const wordBounds = word.getBoundingRect();

    assert.equal(objectInsidePolygon(word, lassoPolygon(loopAround(wordBounds.left - 5, wordBounds.top - 5, wordBounds.left + wordBounds.width + 5, wordBounds.top + wordBounds.height + 5))), true);
    assert.equal(objectInsidePolygon(word, lassoPolygon(loopAround(wordBounds.left - 5, wordBounds.top - 5, wordBounds.left + 10, wordBounds.top + wordBounds.height + 5))), false, 'one letter of three');
  });

  it('takes nothing with a degenerate polygon', () => {
    assert.equal(objectInsidePolygon(strokePath('M 0 0 L 10 0'), [{ x: 0, y: 0 }, { x: 10, y: 0 }]), false);
    assert.deepEqual(objectsInsidePolygon([strokePath('M 0 0 L 10 0')], []), []);
  });
});

describe('objectTapDistance / pickTapTarget — what the pointer touches, nearest first', () => {
  // A hollow circle (the circle tool, a snapped circle) around a word written inside it.
  const hollowCircle = (fill: string | null = 'transparent') => {
    const circle = new Circle({ left: 0, top: 0, originX: 'left', originY: 'top', radius: 100, fill, stroke: 'navy', strokeWidth: 4 });

    circle.setCoords();

    return circle;
  };
  const word = () => {
    const path = strokePath('M 80 100 L 120 100');

    path.setCoords();

    return path;
  };

  it('a tap on a word inside a hollow circle picks the word, even with the circle on top', () => {
    const inner = word();
    const circle = hollowCircle();

    assert.equal(pickTapTarget([inner, circle], { x: 100, y: 101 }, 12), inner);
    assert.equal(pickTapTarget([circle, inner], { x: 100, y: 101 }, 12), inner);
  });

  it('a tap in the empty middle of a hollow circle, away from its outline, picks nothing', () => {
    const circle = hollowCircle();

    assert.equal(objectTapDistance(circle, { x: 100, y: 150 }, 12), null);
    assert.equal(pickTapTarget([word(), circle], { x: 100, y: 150 }, 12), undefined);
  });

  it('a tap on a hollow circle\'s outline picks the circle', () => {
    const circle = hollowCircle();

    assert.equal(pickTapTarget([word(), circle], { x: 100, y: 5 }, 12), circle);
  });

  it('a filled shape is picked anywhere inside it', () => {
    const circle = hollowCircle('gold');

    assert.equal(objectTapDistance(circle, { x: 100, y: 150 }, 12), 0);
    assert.equal(pickTapTarget([circle], { x: 100, y: 150 }, 12), circle);
  });

  it('hollow rects and ellipses are outlines too', () => {
    const rect = new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: 200, height: 100, fill: '', stroke: 'navy', strokeWidth: 2 });
    const ellipse = new Ellipse({ left: 300, top: 0, originX: 'left', originY: 'top', rx: 100, ry: 50, fill: 'transparent', stroke: 'navy', strokeWidth: 2 });

    rect.setCoords();
    ellipse.setCoords();
    assert.equal(objectHitsTap(rect, { x: 100, y: 50 }, 12), false, 'middle of a hollow rect');
    assert.equal(objectHitsTap(rect, { x: 100, y: 3 }, 12), true, 'its top edge');
    assert.equal(objectHitsTap(ellipse, { x: 400, y: 50 }, 12), false, 'middle of a hollow ellipse');
    assert.equal(objectHitsTap(ellipse, { x: 400, y: 2 }, 12), true, 'its top');
  });

  it('of two strokes within reach, the nearer one wins even when it is underneath', () => {
    const lower = strokePath('M 0 0 L 100 0', 2);
    const upper = strokePath('M 0 8 L 100 8', 2);

    lower.setCoords();
    upper.setCoords();
    assert.equal(pickTapTarget([lower, upper], { x: 50, y: 2 }, 12), lower);
    assert.equal(pickTapTarget([lower, upper], { x: 50, y: 6 }, 12), upper);
  });

  it('a locked (non-selectable) background never shadows the ink drawn over it', () => {
    const background = new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: 500, height: 500, fill: 'white', selectable: false });
    const stroke = strokePath('M 0 100 L 100 100', 2);

    background.setCoords();
    stroke.setCoords();
    assert.equal(pickTapTarget([background, stroke], { x: 50, y: 106 }, 12), stroke, 'near the ink: the ink');
    assert.equal(pickTapTarget([background, stroke], { x: 50, y: 300 }, 12), background, 'nowhere near ink: what is there');
  });
});

describe('images are solid — a press anywhere inside one grabs it', () => {
  const picture = () => {
    const element = { width: 400, height: 300, naturalWidth: 400, naturalHeight: 300 } as unknown as HTMLImageElement;
    const image = new FabricImage(element, { left: 0, top: 0, originX: 'left', originY: 'top' });

    image.setCoords();

    return image;
  };

  it('is not an outline: its middle, far from every edge, is on its paint', () => {
    const image = picture();

    assert.equal(isStrokeLike(image), false);
    assert.equal(objectTapDistance(image, { x: 200, y: 150 }, 12), 0);
    assert.equal(objectTapDistance(image, { x: 3, y: 297 }, 12), 0, 'just inside a corner');
    assert.equal(pickTapTarget([image], { x: 200, y: 150 }, 12), image);
  });

  it('a rotated, scaled image is solid in its own frame', () => {
    const image = picture();

    image.set({ originX: 'center', originY: 'center', left: 500, top: 500, angle: 30, scaleX: 0.5, scaleY: 0.5 });
    image.setCoords();
    assert.equal(objectTapDistance(image, { x: 500, y: 500 }, 12), 0, 'its centre');
    assert.equal(objectTapDistance(image, { x: 500 + 200, y: 500 }, 12), null, 'well outside its rotated frame');
  });

  it('ink drawn over a picture stays selectable: touched or within reach, the ink wins', () => {
    const image = picture();
    const ink = strokePath('M 50 100 L 250 100', 2);

    ink.setCoords();
    assert.equal(pickTapTarget([image, ink], { x: 150, y: 100 }, 12), ink, 'on the ink');
    assert.equal(pickTapTarget([image, ink], { x: 150, y: 106 }, 12), ink, 'near the ink');
    assert.equal(pickTapTarget([image, ink], { x: 150, y: 200 }, 12), image, 'away from the ink: the picture');
  });

  it('once the picture is selected, only ink actually touched takes the press — a drag near it moves the picture', () => {
    const image = picture();
    const ink = strokePath('M 50 100 L 250 100', 2);

    ink.setCoords();
    assert.equal(pickTapTarget([image, ink], { x: 150, y: 106 }, 12, image), image);
    assert.equal(pickTapTarget([image, ink], { x: 150, y: 100 }, 12, image), ink);
  });

  it('a picture ABOVE ink hides it: the picture', () => {
    const image = picture();
    const ink = strokePath('M 50 100 L 250 100', 2);

    ink.setCoords();
    assert.equal(pickTapTarget([ink, image], { x: 150, y: 100 }, 12), image);
  });
});

describe('installGeometryTargetFind — Fabric picks by paint', () => {
  /**
   * A stand-in for Fabric 7's `findTarget` with `preserveObjectStacking` (what the board runs): the
   * page search over `_objects`, then — with something selected — the selection's own box search, which
   * wins outright for a multi-selection. `_checkTarget` / the plain search are Fabric's box test.
   */
  const makeCanvas = (objects: FabricObject[], zoom = 1) => {
    let pointerType: string | undefined = 'pen';
    let pointer = new Point(0, 0);
    const canvas = {
      _objects: objects,
      _activeObject: null as FabricObject | null,
      getZoom: () => zoom,
      getViewportPoint: () => new Point(pointer.x * zoom, pointer.y * zoom),
      _checkTarget(obj: FabricObject, p: Point) {
        return !!obj.visible && !!obj.evented && pointInPolygon(p, obj.getCoords());
      },
      _searchPossibleTargets(list: FabricObject[], p: Point, subTargets: FabricObject[]) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (this._checkTarget(list[i]!, p)) return { target: list[i], subTargets };
        }

        return { subTargets: [] as FabricObject[] };
      },
      findTarget(_e: Event): { target?: FabricObject; currentTarget?: FabricObject; currentSubTargets?: FabricObject[]; subTargets: FabricObject[] } {
        const general = this._searchPossibleTargets(this._objects, pointer, []);
        const full = { ...general, currentTarget: general.target, currentSubTargets: general.subTargets };
        const active = this._activeObject;

        if (!active) return full;

        const own = this._searchPossibleTargets([active], pointer, []);

        if (own.target && active.isType('ActiveSelection')) return { ...own, currentTarget: general.target, currentSubTargets: general.subTargets };

        return full;
      },
    };
    const uninstall = installGeometryTargetFind(canvas as never, { pointerType: () => pointerType });
    const at = (x: number, y: number) => {
      pointer = new Point(x, y);

      return canvas.findTarget(new Event('mousedown')).target;
    };

    return { canvas, uninstall, at, setPointerType: (type: string | undefined) => (pointerType = type) };
  };
  const curve = () => {
    const path = strokePath('M 0 0 L 0 100 L 100 100 L 100 0');

    path.setCoords();

    return path;
  };

  it('a tap inside the box of a curve but off its ink finds nothing; on the ink, the curve', () => {
    const path = curve();
    const { at, uninstall } = makeCanvas([path]);

    assert.equal(at(50, 30), undefined, 'Fabric would have said the curve here');
    assert.equal(at(50, 100), path);
    uninstall();
  });

  it('divides the screen tolerance by the zoom, a finger reaching a little further than a pen', () => {
    const path = curve();
    const { at, uninstall, setPointerType } = makeCanvas([path], 2);

    // Pen: 12 screen px at zoom 2 = 6 scene px, plus half the 4px stroke = 8.
    assert.equal(at(50, 107.5), path);
    assert.equal(at(50, 108.5), undefined);
    // Finger: 14 screen px at zoom 2 = 7 scene px, plus 2 = 9.
    setPointerType('touch');
    assert.equal(at(50, 108.5), path);
    assert.equal(at(50, 109.5), undefined);
    uninstall();
  });

  it('a selected hollow circle still drags from its empty middle, but a word inside it is picked', () => {
    const inner = strokePath('M 80 100 L 120 100');
    const circle = new Circle({ left: 0, top: 0, originX: 'left', originY: 'top', radius: 100, fill: 'transparent', stroke: 'navy', strokeWidth: 4 });

    inner.setCoords();
    circle.setCoords();

    const { canvas, at, uninstall } = makeCanvas([inner, circle]);

    canvas._activeObject = circle;
    assert.equal(at(100, 150), circle, 'empty middle of the selection: the selection (it drags)');
    assert.equal(at(100, 101), inner, 'the word inside it: the word');
    uninstall();
  });

  it('a multi-selection drags from inside its box, but ink of an object outside it is picked', () => {
    const a = strokePath('M 0 0 L 100 0');
    const b = strokePath('M 0 100 L 100 100');
    const other = strokePath('M 40 50 L 60 50');

    [a, b, other].forEach((object) => object.setCoords());

    const selection = new ActiveSelection([a, b]);

    selection.setCoords();

    const { canvas, at, uninstall } = makeCanvas([a, b, other]);

    canvas._activeObject = selection;
    assert.equal(at(20, 70), selection, 'empty space inside the selection');
    assert.equal(at(50, 1), selection, 'a member\'s ink: still the selection');
    assert.equal(at(50, 51), other, 'ink that is not in the selection');
    uninstall();
  });

  it('a member of a multi-selection away from the origin is found on its ink, not lost to a neighbour line', () => {
    // Members' cached corners are in the SELECTION's plane; judged as scene coords they would miss, and
    // the line 8 px below would take the tap and steal the selection.
    const a = strokePath('M 300 300 L 400 300');
    const b = strokePath('M 300 400 L 400 400');
    const neighbour = strokePath('M 300 308 L 400 308');

    [a, b, neighbour].forEach((object) => object.setCoords());

    const selection = new ActiveSelection([a, b]);

    selection.setCoords();

    const { canvas, at, uninstall } = makeCanvas([a, b, neighbour]);

    canvas._activeObject = selection;
    assert.equal(at(350, 300), selection);
    assert.equal(at(350, 309), neighbour, 'on the neighbour ink: the neighbour');
    uninstall();
  });

  it('restores Fabric on uninstall', () => {
    const path = curve();
    const { canvas, at, uninstall } = makeCanvas([path]);
    const searchWhileInstalled = canvas._searchPossibleTargets;

    uninstall();
    assert.notEqual(canvas._searchPossibleTargets, searchWhileInstalled);
    assert.equal(at(50, 30), path, 'Fabric\'s box test again');
  });

  describe('a frameless selection (setSelectionGrabsByPaint) is grabbed by its ink only', () => {
    it('a selected L-stroke: its empty box corner finds nothing, its ink (with room to spare) grabs it', () => {
      const ell = strokePath('M 0 0 L 0 100 L 100 100');

      ell.setCoords();

      const { canvas, at, uninstall } = makeCanvas([ell]);
      const ungrab = setSelectionGrabsByPaint(canvas as never);

      canvas._activeObject = ell;
      assert.equal(at(80, 20), undefined, 'empty corner of the box: a new selection starts');
      assert.equal(at(50, 100), ell);
      // Pen reach 12 px; a selected stroke answers to twice that (+ half its 4 px width).
      assert.equal(at(50, 100 + 12 * SELECTED_GRAB_FACTOR + 1), ell);
      assert.equal(at(50, 100 + 12 * SELECTED_GRAB_FACTOR + 3), undefined);
      ungrab();
      assert.equal(at(80, 20), ell, 'without the flag the box grabs again');
      uninstall();
    });

    it('a multi-selection: empty space between its members does not grab it; a member\'s ink does', () => {
      const a = strokePath('M 0 0 L 100 0');
      const b = strokePath('M 0 200 L 100 200');

      [a, b].forEach((object) => object.setCoords());

      const selection = new ActiveSelection([a, b]);

      selection.setCoords();

      const { canvas, at, uninstall } = makeCanvas([a, b]);
      const ungrab = setSelectionGrabsByPaint(canvas as never);

      canvas._activeObject = selection;
      assert.equal(at(50, 100), undefined);
      assert.equal(at(50, 2), selection);
      assert.equal(selectionGrabbedByPaint(selection, { x: 50, y: 198 }, 12), true);
      ungrab();
      uninstall();
    });
  });
});
