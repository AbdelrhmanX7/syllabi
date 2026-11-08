# Ruler — notes for Claude and other models

The notebook board has an on-screen **ruler** (chip «Ruler» top-right). It exists so drawings match
real-world size, e.g. EAS 102 cross-sections, scale bars, measured angles. Code:
`components/notebook/RulerOverlay.tsx`, `lib/ruler/calibration.ts`, `lib/ruler/geometry.ts`,
`packages/whiteboard-react/.../brushes/rulerSnap.ts` (stroke snapping).

## What the ruler is
- 30 cm max (shorter on a narrow board), 34 mm thick. cm/mm ticks on the top edge; inch ticks (1/8) on the
  bottom edge when enabled. Ticks follow the **page** by default, see «Page scale» below; «Real» mode keeps them PHYSICAL and screen-space.
- One finger on it drags it; a second finger rotates it (magnet at multiples of 45° within 3°; readout in
  degrees, 0 ≤ a < 180). The pen passes through the ruler to the board.
- A pen stroke drawn along either long side (within 14 screen px, ≥ 24 px long) commits as one straight
  line on that side, from where the stroke began to where it ended.
- The ⚙ button calibrates against a real card (85.60 mm); stored in `localStorage` key `study_ruler`.

## Page scale («Page» / «Real» button on the ruler)
Default **Page**: 1 mm on the ruler = 1 mm of paper = 3.7795 board units, so on glass it is
`3.7795 × viewport zoom` CSS px per mm and the ruler re-renders when the zoom settles (the editor reports it
through `onViewportZoomChange`). A printed inch or a map scale bar then lines up with the inch/cm ticks at any
zoom. The 0 end keeps its screen position when the length changes; body thickness and glyph sizes stay physical.
**Real** (`real: true` in `study_ruler`) uses `cssPxPerMm`, the old glass-mm behaviour. The pinch itself is a CSS
preview, so the ticks catch up when the gesture settles.

## Coordinate systems (do not mix them)
| Space | Unit | Notes |
|---|---|---|
| Board / page units | 1 unit = 1 CSS px at zoom 1 | what ink, `layoutDiagram` and the board AI emit. Paper scale: **1 mm of paper = 96/25.4 = 3.7795 units** (`BOARD_PX_PER_MM`; PDF export prints at 96 dpi). |
| Screen CSS px | = board units × viewport zoom | ruler ticks live here |
| Physical mm | screen CSS px ÷ `cssPxPerMm` | what a real ruler laid on the tablet reads |

`cssPxPerMm` (from `currentScale()`): manual calibration → known device → fallback 96/25.4 = 3.7795.

**Galaxy Tab S9 Ultra** (the owner's device): 14.6", 2960×1848 → 239.0 ppi → **9.41 physical px/mm**.
Matched by physical pixel size (`screen.width × devicePixelRatio`), so it holds at any DPR:
at DPR 2 → **4.70 CSS px/mm** (1 cm = 47.0 CSS px); at DPR 2.5 → 3.76; at DPR 3 → 3.14.

## Making generated content the right size
Two honest options, pick by what the user means:
1. **Paper size** (printed / exported / "on the page"): use `PAGE_UNITS_PER_PAPER_MM = 3.7795` units per mm.
   A 10 cm line = 378 units. This is independent of device and zoom; it is also what lined/grid
   `paperSpacingMm` uses.
2. **Real size on this screen right now** (user will hold a ruler to the tablet): units per mm =
   `cssPxPerMm / zoom` (`pageUnitsForScreenMm`). Only valid at the viewport zoom you computed it for;
   at zoom 1 on the S9 Ultra (DPR 2), 1 cm ≈ 47.0 units. Say which zoom you assumed.

Prefer option 1 unless asked otherwise, and label drawings with their scale.

### Measured lines and scale bars
- A map/section drawn at scale 1:N: a real length `L` metres is `L * 1000 / N` mm on paper →
  `L * 1000 / N * 3.7795` units. Example 1:25 000, 2 km → 80 mm → 302 units.
- Scale bar: draw a horizontal line of the paper length of a round real distance (1 km at 1:25 000 =
  40 mm = 151 units), tick every 1/10, label the end with the real distance AND the ratio («1:25 000»).
- Angles (dip/strike, bedding): draw with exact `cos/sin` in board units; the y axis points DOWN, so a dip
  of θ below horizontal to the right is `(x + d·cosθ, y + d·sinθ)`. Label the angle in degrees.
- Vertical exaggeration (cross-sections): state it («VE ×2») and apply the factor to y only.
- Straight geology lines (contacts, faults): emit true straight lines, not freehand paths.

## Do not
- Do not assume 96 dpi equals the screen: on the S9 Ultra 1 CSS px ≠ 1/96 inch of glass (it is ≈ 0.213 mm
  vs 0.265 mm). Option 1 is a paper scale, not a screen scale.
- Do not bake `cssPxPerMm` into saved ink: it is device-dependent and the page syncs between devices.

## Ruler presets (per page)
A board page can carry a saved ruler: `{ pageFactor, angleDeg, zeroAt: {xMm, yMm}, mapScale, groundUnit, setBy, updatedAt }`
(`GET/PUT/DELETE /study/pages/:pageId/ruler[/:page]`, `lib/api/endpoints.ts`; page = board page number, 1-based).
Claude saves one through the Study MCP; the «Save for page» button on the ruler saves the student's current one
(`setBy: 'user'`). When the page opens with a preset the ruler shows itself, its `pageFactor` overrides the stored one
for that page only, and its 0 end is pinned to `zeroAt` (paper mm × 3.7795 → board units → screen px through the editor's
viewport transform, `lib/ruler/preset.ts`) across pan and zoom until a finger drags the ruler. With `mapScale` the lower
edge reads ground distance in `groundUnit` (1:24000 in ft: 1 in = 2000 ft) and the centre readout shows «1:24,000».
A failed or 404 GET means no preset; the ruler behaves as before.
