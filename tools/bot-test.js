import { createTrack } from '../shared/track.js';
import { createCar, stepCar } from '../shared/physics.js';

const track = createTrack(12345, 900);
const car = createCar(track);
const dt = 1 / 60;

for (let f = 0; f < 60 * 70; f++) {
  // simple bot: full gas on the ground, coast in the air
  const input = f < 30 ? { throttle: 0 } : { throttle: car.grounded ? 1 : 0 };
  stepCar(car, input, track, dt);
  if (!Number.isFinite(car.x)) {
    console.log('NaN', f);
    process.exit(1);
  }
  if (f % 300 === 0) {
    console.log(
      `t=${(f / 60).toFixed(0).padStart(2)}s x=${car.x.toFixed(0).padStart(4)}m ` +
        `spd=${(car.speed * 3.6).toFixed(0).padStart(3)}km/h ` +
        `ang=${((car.angle * 180) / Math.PI).toFixed(0).padStart(4)} ` +
        `ground=${car.grounded ? 1 : 0} cp=${car.checkpointX.toFixed(0)}`
    );
  }
  if (car.x >= track.finishX) {
    console.log(`FINISHED at t=${(f / 60).toFixed(1)}s`);
    break;
  }
}
console.log('distance', car.x.toFixed(1), '/', track.length);
