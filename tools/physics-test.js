import { createTrack, randomSeed } from '../shared/track.js';
import { createCar, stepCar, respawnCar } from '../shared/physics.js';

const track = createTrack(12345, 900);
const car = createCar(track);

let maxPen = 0;
let flips = 0;
let lastX = car.x;
const dt = 1 / 60;

for (let frame = 0; frame < 60 * 45; frame++) {
  const throttle = frame < 60 * 1 ? 0 : 1;
  stepCar(car, { throttle }, track, dt);

  if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.angle)) {
    console.error('NaN at frame', frame, car);
    process.exit(1);
  }
  if (car.x < lastX - 5) flips++;
  lastX = car.x;

  if (frame % 120 === 0) {
    console.log(
      `t=${(frame / 60).toFixed(0).padStart(2)}s x=${car.x.toFixed(1).padStart(6)}m y=${car.y.toFixed(1)} ` +
        `speed=${(car.speed * 3.6).toFixed(0).padStart(3)}km/h angle=${((car.angle * 180) / Math.PI).toFixed(0)}deg ` +
        `grounded=${car.grounded} cp=${car.checkpointX.toFixed(0)}`
    );
  }
}

console.log('\n--- result ---');
console.log('distance:', car.x.toFixed(1), 'm  (track length 900)');
console.log('top speed:', (car.speed * 3.6).toFixed(0), 'km/h');
console.log('max penetration:', maxPen.toFixed(3));
console.log('respawns/backslides:', flips);
console.log('finished:', car.finished);

// sanity checks for the physics
const ok = car.x > 250 && car.x < 2000 && Number.isFinite(car.y);
console.log(ok ? 'PHYSICS OK' : 'PHYSICS FAILED');
process.exit(ok ? 0 : 1);
