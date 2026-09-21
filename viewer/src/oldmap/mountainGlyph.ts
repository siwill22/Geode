/*
 * The hachured mountain glyph, ported from the reference notebook's own
 * `drawing.eps` (~/GIT/degenerative_art/drawing.eps) so the viewer draws the
 * same engraved range the notebook does rather than a lookalike.
 *
 * GENERATED, not written: prep/eps_to_glyph.py parses the EPS's cairo path ops
 * (12 moveTo, 130 bezierCurveTo, 6 closePath across six overlapping ridges) and
 * emits the body of buildMountainGlyph() below. Re-run it rather than editing
 * the coordinates by hand.
 *
 * Normalised to a unit WIDTH -- x spans -0.5..0.5, y runs 0 at the baseline to
 * -ASPECT at the peak, canvas-style with y growing downward. So a caller scales
 * by the pixel width it wants and translates to where the range should stand;
 * the glyph sits ON that point rather than being centred on it, which is how a
 * mountain symbol reads on a map.
 *
 * Why not petrify's `points.js`: that ships six abstract symbols at ~3.4
 * px sized for a scatter of observations, and these are per-frame paleo-
 * coordinate lists that need none of PointLayer's rotation or lifespan
 * machinery. See docs/plans/old-map-viewer.md.
 */

/** Height as a fraction of width, from the EPS bounding box (450 x 296.5). */
export const MOUNTAIN_ASPECT = 0.6590;

let cached: Path2D | null = null;

/** The glyph, built once. Path2D is immutable in use here -- callers transform
 *  the context, never the path -- so one instance is shared by every glyph on
 *  every frame. */
export function mountainGlyph(): Path2D {
  return (cached ??= buildMountainGlyph());
}

function buildMountainGlyph(): Path2D {
  const p = new Path2D();
  p.moveTo(-0.4795, -0.2627);
  p.bezierCurveTo(-0.4685, -0.2662, -0.4574, -0.2692, -0.4473, -0.2750);
  p.bezierCurveTo(-0.4363, -0.2814, -0.4189, -0.2938, -0.4088, -0.3007);
  p.bezierCurveTo(-0.3692, -0.3288, -0.3305, -0.3580, -0.2916, -0.3871);
  p.bezierCurveTo(-0.2733, -0.4013, -0.2539, -0.4142, -0.2364, -0.4294);
  p.bezierCurveTo(-0.2262, -0.4383, -0.2170, -0.4476, -0.2073, -0.4571);
  p.bezierCurveTo(-0.1892, -0.4759, -0.1719, -0.4956, -0.1563, -0.5166);
  p.bezierCurveTo(-0.1471, -0.5289, -0.1438, -0.5346, -0.1355, -0.5473);
  p.bezierCurveTo(-0.1182, -0.5732, -0.1062, -0.6018, -0.0966, -0.6313);
  p.bezierCurveTo(-0.0933, -0.6427, -0.0948, -0.6373, -0.0921, -0.6474);
  p.bezierCurveTo(-0.0921, -0.6474, -0.1135, -0.6590, -0.1135, -0.6590);
  p.bezierCurveTo(-0.1159, -0.6489, -0.1145, -0.6543, -0.1176, -0.6427);
  p.bezierCurveTo(-0.1265, -0.6133, -0.1385, -0.5848, -0.1555, -0.5590);
  p.bezierCurveTo(-0.1588, -0.5539, -0.1620, -0.5487, -0.1654, -0.5437);
  p.bezierCurveTo(-0.1835, -0.5170, -0.2045, -0.4923, -0.2269, -0.4691);
  p.bezierCurveTo(-0.2395, -0.4569, -0.2429, -0.4531, -0.2562, -0.4418);
  p.bezierCurveTo(-0.2738, -0.4269, -0.2928, -0.4136, -0.3109, -0.3993);
  p.bezierCurveTo(-0.3494, -0.3699, -0.3881, -0.3406, -0.4277, -0.3128);
  p.bezierCurveTo(-0.4428, -0.3028, -0.4514, -0.2964, -0.4672, -0.2882);
  p.bezierCurveTo(-0.4775, -0.2828, -0.4888, -0.2799, -0.5000, -0.2768);
  p.bezierCurveTo(-0.5000, -0.2768, -0.4795, -0.2627, -0.4795, -0.2627);
  p.closePath();
  p.moveTo(-0.1115, -0.6512);
  p.bezierCurveTo(-0.1087, -0.6350, -0.1021, -0.6197, -0.0955, -0.6047);
  p.bezierCurveTo(-0.0865, -0.5850, -0.0765, -0.5658, -0.0670, -0.5463);
  p.bezierCurveTo(-0.0568, -0.5246, -0.0446, -0.5039, -0.0317, -0.4836);
  p.bezierCurveTo(-0.0216, -0.4682, -0.0125, -0.4522, -0.0037, -0.4361);
  p.bezierCurveTo(0.0051, -0.4205, 0.0138, -0.4049, 0.0230, -0.3896);
  p.bezierCurveTo(0.0297, -0.3783, 0.0379, -0.3682, 0.0474, -0.3593);
  p.bezierCurveTo(0.0530, -0.3543, 0.0590, -0.3498, 0.0649, -0.3453);
  p.bezierCurveTo(0.0660, -0.3445, 0.0671, -0.3437, 0.0681, -0.3429);
  p.bezierCurveTo(0.0681, -0.3429, 0.0914, -0.3336, 0.0914, -0.3336);
  p.bezierCurveTo(0.0903, -0.3345, 0.0892, -0.3353, 0.0881, -0.3361);
  p.bezierCurveTo(0.0820, -0.3406, 0.0759, -0.3450, 0.0702, -0.3499);
  p.bezierCurveTo(0.0605, -0.3587, 0.0520, -0.3685, 0.0453, -0.3797);
  p.bezierCurveTo(0.0360, -0.3950, 0.0271, -0.4106, 0.0184, -0.4262);
  p.bezierCurveTo(0.0096, -0.4425, 0.0005, -0.4585, -0.0098, -0.4740);
  p.bezierCurveTo(-0.0228, -0.4941, -0.0351, -0.5147, -0.0452, -0.5364);
  p.bezierCurveTo(-0.0547, -0.5558, -0.0644, -0.5750, -0.0735, -0.5946);
  p.bezierCurveTo(-0.0800, -0.6093, -0.0866, -0.6242, -0.0893, -0.6402);
  p.bezierCurveTo(-0.0893, -0.6402, -0.1115, -0.6512, -0.1115, -0.6512);
  p.closePath();
  p.moveTo(0.0001, -0.2314);
  p.bezierCurveTo(0.0016, -0.2325, 0.0031, -0.2335, 0.0046, -0.2346);
  p.bezierCurveTo(0.0121, -0.2405, 0.0193, -0.2468, 0.0267, -0.2528);
  p.bezierCurveTo(0.0415, -0.2646, 0.0568, -0.2757, 0.0722, -0.2867);
  p.bezierCurveTo(0.0990, -0.3053, 0.1259, -0.3239, 0.1507, -0.3450);
  p.bezierCurveTo(0.1617, -0.3552, 0.1731, -0.3653, 0.1824, -0.3771);
  p.bezierCurveTo(0.1867, -0.3826, 0.1933, -0.3927, 0.1971, -0.3983);
  p.bezierCurveTo(0.2122, -0.4207, 0.2234, -0.4452, 0.2340, -0.4699);
  p.bezierCurveTo(0.2408, -0.4860, 0.2476, -0.5021, 0.2545, -0.5182);
  p.bezierCurveTo(0.2589, -0.5284, 0.2634, -0.5387, 0.2685, -0.5487);
  p.bezierCurveTo(0.2690, -0.5496, 0.2695, -0.5506, 0.2700, -0.5515);
  p.bezierCurveTo(0.2700, -0.5515, 0.2484, -0.5638, 0.2484, -0.5638);
  p.bezierCurveTo(0.2479, -0.5628, 0.2474, -0.5619, 0.2470, -0.5609);
  p.bezierCurveTo(0.2421, -0.5508, 0.2376, -0.5405, 0.2331, -0.5302);
  p.bezierCurveTo(0.2264, -0.5140, 0.2199, -0.4977, 0.2133, -0.4816);
  p.bezierCurveTo(0.2028, -0.4570, 0.1917, -0.4325, 0.1766, -0.4103);
  p.bezierCurveTo(0.1719, -0.4034, 0.1671, -0.3961, 0.1619, -0.3895);
  p.bezierCurveTo(0.1526, -0.3779, 0.1414, -0.3678, 0.1306, -0.3576);
  p.bezierCurveTo(0.1060, -0.3363, 0.0794, -0.3176, 0.0527, -0.2991);
  p.bezierCurveTo(0.0373, -0.2880, 0.0220, -0.2768, 0.0069, -0.2652);
  p.bezierCurveTo(-0.0027, -0.2578, -0.0066, -0.2544, -0.0161, -0.2479);
  p.bezierCurveTo(-0.0176, -0.2468, -0.0192, -0.2459, -0.0208, -0.2450);
  p.bezierCurveTo(-0.0208, -0.2450, 0.0001, -0.2314, 0.0001, -0.2314);
  p.closePath();
  p.moveTo(0.2495, -0.5625);
  p.bezierCurveTo(0.2539, -0.5464, 0.2611, -0.5312, 0.2677, -0.5159);
  p.bezierCurveTo(0.2727, -0.5044, 0.2776, -0.4929, 0.2825, -0.4814);
  p.bezierCurveTo(0.2975, -0.4452, 0.3144, -0.4099, 0.3318, -0.3749);
  p.bezierCurveTo(0.3448, -0.3491, 0.3584, -0.3237, 0.3727, -0.2986);
  p.bezierCurveTo(0.3824, -0.2808, 0.3948, -0.2647, 0.4075, -0.2490);
  p.bezierCurveTo(0.4180, -0.2364, 0.4274, -0.2230, 0.4375, -0.2102);
  p.bezierCurveTo(0.4509, -0.1950, 0.4700, -0.1864, 0.4883, -0.1785);
  p.bezierCurveTo(0.4963, -0.1754, 0.4924, -0.1770, 0.5000, -0.1740);
  p.bezierCurveTo(0.5000, -0.1740, 0.4807, -0.1891, 0.4807, -0.1891);
  p.bezierCurveTo(0.4732, -0.1920, 0.4771, -0.1905, 0.4692, -0.1937);
  p.bezierCurveTo(0.4618, -0.1970, 0.4379, -0.2089, 0.4717, -0.1906);
  p.bezierCurveTo(0.4732, -0.1898, 0.4689, -0.1926, 0.4675, -0.1937);
  p.bezierCurveTo(0.4636, -0.1967, 0.4636, -0.1970, 0.4601, -0.2005);
  p.bezierCurveTo(0.4496, -0.2132, 0.4403, -0.2269, 0.4297, -0.2395);
  p.bezierCurveTo(0.4169, -0.2552, 0.4043, -0.2712, 0.3945, -0.2889);
  p.bezierCurveTo(0.3799, -0.3140, 0.3661, -0.3395, 0.3529, -0.3653);
  p.bezierCurveTo(0.3354, -0.4003, 0.3183, -0.4355, 0.3035, -0.4718);
  p.bezierCurveTo(0.2986, -0.4832, 0.2938, -0.4947, 0.2890, -0.5061);
  p.bezierCurveTo(0.2826, -0.5211, 0.2756, -0.5359, 0.2718, -0.5518);
  p.bezierCurveTo(0.2718, -0.5518, 0.2495, -0.5625, 0.2495, -0.5625);
  p.closePath();
  p.moveTo(-0.4465, -0.0252);
  p.bezierCurveTo(-0.4158, -0.0348, -0.3872, -0.0500, -0.3584, -0.0641);
  p.bezierCurveTo(-0.3208, -0.0834, -0.2833, -0.1038, -0.2494, -0.1292);
  p.bezierCurveTo(-0.2437, -0.1334, -0.2383, -0.1380, -0.2328, -0.1424);
  p.bezierCurveTo(-0.2086, -0.1627, -0.1859, -0.1845, -0.1630, -0.2063);
  p.bezierCurveTo(-0.1488, -0.2200, -0.1351, -0.2342, -0.1221, -0.2491);
  p.bezierCurveTo(-0.1154, -0.2575, -0.1085, -0.2658, -0.1017, -0.2742);
  p.bezierCurveTo(-0.1012, -0.2749, -0.1007, -0.2757, -0.1001, -0.2765);
  p.bezierCurveTo(-0.1001, -0.2765, -0.1216, -0.2891, -0.1216, -0.2891);
  p.bezierCurveTo(-0.1221, -0.2883, -0.1226, -0.2876, -0.1230, -0.2869);
  p.bezierCurveTo(-0.1296, -0.2784, -0.1363, -0.2700, -0.1429, -0.2616);
  p.bezierCurveTo(-0.1557, -0.2467, -0.1693, -0.2326, -0.1833, -0.2187);
  p.bezierCurveTo(-0.2058, -0.1969, -0.2283, -0.1749, -0.2521, -0.1546);
  p.bezierCurveTo(-0.2668, -0.1429, -0.2706, -0.1395, -0.2861, -0.1288);
  p.bezierCurveTo(-0.3150, -0.1090, -0.3456, -0.0919, -0.3770, -0.0764);
  p.bezierCurveTo(-0.4045, -0.0634, -0.3958, -0.0673, -0.4215, -0.0560);
  p.bezierCurveTo(-0.4363, -0.0495, -0.4511, -0.0428, -0.4669, -0.0392);
  p.bezierCurveTo(-0.4669, -0.0392, -0.4465, -0.0252, -0.4465, -0.0252);
  p.closePath();
  p.moveTo(-0.1181, -0.2883);
  p.bezierCurveTo(-0.1165, -0.2854, -0.1150, -0.2824, -0.1133, -0.2796);
  p.bezierCurveTo(-0.1087, -0.2720, -0.0984, -0.2566, -0.0937, -0.2497);
  p.bezierCurveTo(-0.0829, -0.2336, -0.0719, -0.2177, -0.0607, -0.2018);
  p.bezierCurveTo(-0.0572, -0.1970, -0.0537, -0.1922, -0.0502, -0.1873);
  p.bezierCurveTo(-0.0436, -0.1783, -0.0383, -0.1706, -0.0314, -0.1619);
  p.bezierCurveTo(-0.0211, -0.1491, -0.0101, -0.1368, 0.0008, -0.1246);
  p.bezierCurveTo(0.0229, -0.1009, 0.0463, -0.0783, 0.0721, -0.0587);
  p.bezierCurveTo(0.0764, -0.0555, 0.0808, -0.0526, 0.0851, -0.0495);
  p.bezierCurveTo(0.1071, -0.0355, 0.1294, -0.0216, 0.1537, -0.0119);
  p.bezierCurveTo(0.1558, -0.0107, 0.1580, -0.0099, 0.1602, -0.0089);
  p.bezierCurveTo(0.1610, -0.0085, 0.1634, -0.0071, 0.1626, -0.0076);
  p.bezierCurveTo(0.1563, -0.0112, 0.1500, -0.0148, 0.1436, -0.0184);
  p.bezierCurveTo(0.1429, -0.0189, 0.1451, -0.0175, 0.1458, -0.0171);
  p.bezierCurveTo(0.1537, -0.0127, 0.1615, -0.0082, 0.1694, -0.0038);
  p.bezierCurveTo(0.1725, -0.0022, 0.1756, -0.0010, 0.1790, -0.0000);
  p.bezierCurveTo(0.1790, -0.0000, 0.1592, -0.0153, 0.1592, -0.0153);
  p.bezierCurveTo(0.1560, -0.0164, 0.1530, -0.0179, 0.1499, -0.0193);
  p.bezierCurveTo(0.1563, -0.0156, 0.1627, -0.0119, 0.1691, -0.0082);
  p.bezierCurveTo(0.1698, -0.0078, 0.1676, -0.0090, 0.1668, -0.0095);
  p.bezierCurveTo(0.1559, -0.0157, 0.1459, -0.0225, 0.1343, -0.0271);
  p.bezierCurveTo(0.1294, -0.0291, 0.1294, -0.0291, 0.1242, -0.0315);
  p.bezierCurveTo(0.1219, -0.0326, 0.1153, -0.0363, 0.1173, -0.0348);
  p.bezierCurveTo(0.1209, -0.0318, 0.1256, -0.0305, 0.1292, -0.0275);
  p.bezierCurveTo(0.1359, -0.0219, 0.0975, -0.0476, 0.1069, -0.0409);
  p.bezierCurveTo(0.1025, -0.0440, 0.0980, -0.0469, 0.0937, -0.0500);
  p.bezierCurveTo(0.0677, -0.0693, 0.0443, -0.0918, 0.0223, -0.1156);
  p.bezierCurveTo(0.0114, -0.1277, 0.0005, -0.1399, -0.0097, -0.1526);
  p.bezierCurveTo(-0.0178, -0.1626, -0.0212, -0.1676, -0.0289, -0.1781);
  p.bezierCurveTo(-0.0325, -0.1830, -0.0360, -0.1878, -0.0396, -0.1926);
  p.bezierCurveTo(-0.0507, -0.2085, -0.0618, -0.2244, -0.0726, -0.2404);
  p.bezierCurveTo(-0.0782, -0.2488, -0.0861, -0.2608, -0.0913, -0.2697);
  p.bezierCurveTo(-0.0928, -0.2724, -0.0942, -0.2752, -0.0956, -0.2779);
  p.bezierCurveTo(-0.0956, -0.2779, -0.1181, -0.2883, -0.1181, -0.2883);
  p.closePath();

  return p;
}
