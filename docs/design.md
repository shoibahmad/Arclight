# Design notes

Why the game is shaped the way it is.

---

## The problem with anti-gravity racers

The genre has a well-worn shape: very fast, weapons, boost pads, a shield bar
you top up by driving over pickups. It plays well, and it has a structural
weakness — on any given lap the optimal line and the optimal use of resources
are the same thing. You take the racing line, you drive over the pads that
happen to be on it, you fire what you pick up. There is a correct lap, and
mastery is executing it more precisely.

Arclight's one structural idea is to make the line and the resource the same
system, and then make the line move.

## The arcline

A luminous ideal line is threaded through the circuit. Riding it charges your
cell. The cell is the **only** resource: boost, shields and the air brakes all
draw from it, and nothing else refills it.

Three consequences fall out:

**Every corner becomes a question about the last straight.** Boost down the
Mile and you reach Dockhead faster with an empty cell and no shield. Take the
corner wide to defend and you have paid for it twice — in time, and in charge
you did not earn.

**The optimal line stops being a single answer.** The fastest way through a
corner and the best-charging way through it are usually, but not always, the
same. Where they differ, there is a decision.

**It is legible.** You are on the glowing ribbon or you are not. There is no
resource UI to parse mid-corner; the HUD indicator is a confirmation, not the
information.

### Why it moves

If the line never changed, it would be memorised in three laps and the game
would collapse back to execution. So it is re-derived every lap with a
different wander phase.

The wander is deliberately constrained. It is low-frequency (two slow sine
components, periods of two to nine cycles around the lap), it is scaled by
the room left between the base line and the road edge, and it is clamped
inside the barriers. A corner where the base line is already on the kerb does
not move at all; only the open sections do. The result asks you to keep
looking without ever asking for something undrivable — there is a unit test
asserting the line never kinks more than 0.35 m per 2 m travelled.

Lap one is always the clean line, so a new player meets the circuit before it
starts shifting.

### How the base line is built

Apex targets come straight from curvature: the inside of the corner,
proportional to how tight it is. On its own that is useless — it would have
you clipping every apex with no entry or exit.

The step that makes it a racing line is smoothing it over a ninety-metre
window. The filter pulls the line toward the *opposite* side before and after
each corner, which produces the wide entry and wide exit for free. It is one
line of code doing the work that an explicit entry/apex/exit model would need
fifty for, and it generalises to corner sequences without special cases.

---

## Handling

The craft is not simulated realistically and is not trying to be. It is built
around three properties a player can feel inside one lap.

**Grip grows with speed.** `grip = base + speed × rate`. The craft plants
itself the harder it is driven. This is the single most important choice in
the handling model: it means lifting mid-corner is punished, which makes
commitment the skill the game rewards, and it gives the craft a distinctly
non-automotive character — it feels like it is being pressed down by air
rather than held up by tyres.

**Yaw authority shrinks with speed.** At 400 kph the craft responds gently,
so small corrections are possible; in a hairpin it rotates sharply. Without
this the craft is simultaneously twitchy on the straight and understeering in
the slow corners.

**The air brakes are a cost.** They rotate the craft, scrub speed, and draw
from the cell. A free rotation button would be used constantly and would
flatten the difference between the craft; a costed one is a decision.

### Why there is no collision mesh

The craft is a point mass held to the road by a spring, positioned in the
track's own frame — distance along, lateral offset, height above surface.

A conventional rigid body on three kilometres of banked ribbon, at 130 m/s,
spends its life tunnelling through barriers and catching geometry edges. The
projection approach makes the barrier test `|lateral| > width/2 + kerb`,
which is exact at any speed and any step size. A craft cannot leave the
circuit by accident because it never had the freedom to.

The cost is that genuinely off-track excursions are not possible — but in a
walled anti-gravity circuit they should not be.

---

## The craft

Four frames, each a different answer to "how do you want to pay for the
cell?"

- **Kestrel** — the reference. Nothing remarkable, nothing surprising.
- **Vireo** — charges 30% faster and grips hardest, but runs out of top end.
  Forgiving of a sloppy line because it earns the cell back quickly.
- **Mantis** — fastest and least forgiving. Thin shielding, a greedy cell,
  and enough agility to rotate further than you asked. Rewards a driver who
  is actually on the line, punishes one who is nearly on it.
- **Oriole** — heavy, slow to turn, almost impossible to put out of a race.
  Still there on the last lap when the Mantis is limping.

The spread is deliberately narrow in lap time — under 10% across the roster
under identical AI control — and wide in *how* that lap time is achieved.

## Classes

Apex is not a difficulty slider. Speed rises 22% and grip only 9%, so corners
that were flat in Sprint need a genuine lift, and the braking points move.
The same circuit is new content rather than the same circuit faster.

Apex is locked until the second cup is on the podium, so every circuit is met
at the slower speed first.

---

## The field

The AI drives the same simulation the player does. Same thrust, same grip,
same cell, no hidden speed, no scripted lines. Everything it does comes out of
the same `controls` object the keyboard produces.

That constraint is not purity for its own sake. The moment an AI craft can
corner harder than the physics allows, close racing stops being readable —
the player cannot predict what the car in front will do, and losing stops
feeling like a mistake they made.

Skill scales the *margins*, not the capability: a lower-skilled driver brakes
earlier, holds a sloppier line, and spends its cell badly.

Personality changes behaviour rather than statistics. Aggression sets how
much cell a driver will commit when there is someone to attack; consistency
sets line wander and mistake frequency; bravery sets how close to the
computed corner limit they run. Marchetti will out-brake himself into a wall;
Pradhan will not, and will also not pass you.

Catch-up is one-sided and small — at most 5.5% extra pace for a driver more
than a third of a lap behind, and nobody is ever slowed down. Rubber banding
that drags the leader backwards is immediately obvious and makes winning feel
unearned.

Drivers make genuine mistakes on a timer weighted by consistency. The result
is a brief lift and a line error, not a scripted spin — enough to lose a few
craft lengths. A field that never errs is both unbeatable and boring to
follow.

---

## Circuits

Six circuits across three environments, each with a job:

| Circuit | Job |
| --- | --- |
| Meridian Flats | Teach the game. Wide, every corner visible from the one before. |
| Saltflat Run | Pure speed. The arcline at 400 kph is a thread. |
| Lowtown Spiral | Deny recharging. Ten corners, no straight long enough. |
| Harbour Mile | One enormous straight. A pure question about boost. |
| Vaskr Hollow | Linked sweepers. The cell must be earned in the corners. |
| Calder Shelf | Vertical. Grip falls away over the crests. |

They are authored as corner sequences, not coordinates, because coordinates
are untunable — moving one apex means re-deriving every point after it, and
you cannot tell from a list of numbers whether a corner is fast or slow.

Two of them (Lowtown, Vaskr) are built as two near-mirrored halves turning
180° each. A loop shaped that way closes on itself almost exactly, which
leaves the layout builder nothing to correct, so the corners are the radii
that were actually written down. Both were redesigned that way after
`tools/layout-report.mjs` reported the first attempt missing closure by 18%
of a lap — more than the builder was willing to absorb without visibly
skewing the shape.

---

## Presentation

**The camera's up vector follows the road, not the world.** Banked corners
roll the horizon. Without this, banking is something you read about in a
track description rather than something you see.

**The camera aims down the circuit, not at the craft.** A corner is framed
before you arrive at it. Aiming at the craft puts the apex off-screen at
exactly the moment you need it.

**Speed effects scale with r².** Radial blur and chromatic aberration grow
toward the edges of the frame and leave the middle — where the player is
actually reading the road — clean at any speed.

**The HUD is DOM, the minimap is 2D canvas, the world is WebGL.** Text in a
WebGL canvas either needs a glyph atlas or ends up as blurry textured quads,
and the one thing a racing HUD cannot be is hard to read at a glance.

**Audio is synthesised, not sampled.** An engine note generated from speed,
throttle and boost follows the simulation continuously. A looped sample has
to be pitch-shifted and crossfaded and always betrays itself at the loop
point. The score is generative and keyed to lap number and the gap to the
craft ahead, so it tightens as a race does with no transitions to author.

---

## Things deliberately not in the game

**Weapons.** They would be a second resource competing with the cell, and the
cell economy is the game. A weapon pickup also re-introduces exactly the
"drive over the thing on the racing line" loop the arcline exists to replace.

**Damage that ends a race on contact.** Integrity falls with impacts and the
craft gets slower and flickers, but a race you can no longer win is a race
you stop paying attention to. The penalty is positional, not terminal.

**An off-track penalty system.** The barriers are the penalty. A circuit with
walls does not need a track-limits rule.

**Difficulty settings.** The class system is the difficulty curve, and it is
tied to content rather than to a menu.
