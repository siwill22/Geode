# Ocean Layer depth is a slider over 2D planes, not a mantle-style Cutaway

The Ocean Layer's data (temperature, salinity, current at 20 real depth
levels per Frame) is structurally the same shape as a mantle Convection
Model — a true 3D interior, one real depth axis, no repurposing involved.
The tomography viewer already has machinery built exactly for exploring
that shape: Cutaway, Wall, Isosurface, Cut Depth.

We're not using it. The Ocean Layer treats depth exactly the way the
Climate Layer already treats Month: a slider that repaints the flat globe
surface with a different depth-indexed plane (see `CONTEXT.md`'s Ocean
Depth and Month entries — both are the same underlying repurposed axis,
Volume, just given a different meaning per Layer). Depth becomes a scrub
axis, not a spatial cutaway into the globe's interior.

Reasons: the new Valdes/BRIDGE instance (ADR-0008) is meant to stay a thin
wrapper over the existing climate rendering path, and adopting Cutaway
means porting a meaningful slice of the tomography pipeline into that path
for the first time. It also matches what was actually asked for — "ocean
properties and velocity at different depths" reads as wanting to scrub
through depth and see what's there, not to carve the globe open. A true
cutaway-based ocean view remains possible as a later, additive enhancement;
this decision only says it isn't the starting point.
