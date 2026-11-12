// Shared car physics. Runs identically in Node (authoritative server) and in
// the browser (client-side prediction), using a fixed timestep.
//
// World units are metres, +x is forward, +y is DOWN (screen coordinates).

export const CAR = {
  wheelbase: 2.4,
  wheelDrop: 0.36, // wheels sit this far below the chassis centre (local y)
  radius: 0.42,
  mass: 230,
  inertia: ((230 * 2.4 * 2.4) / 12) * 1.6,
  gravity: 16,

  spring: 62000, // suspension stiffness per wheel (N/m)
  damper: 5200, // suspension damping (Ns/m)
  maxPenetration: 0.5,
  maxNormal: 46000,

  drive: 4200, // peak engine force (N)
  grip: 1.55, // friction coefficient
  maxSpeed: 22, // m/s, engine force fades out here
  rollResist: 14,
  airTorque: 2.8, // rad/s^2 while airborne
  maxSpin: 5, // rad/s cap while airborne
  alignTorque: 2200, // arcade assist that settles the chassis on the ground
  drag: 0.055,
  angularDrag: 1.6,

  resetFlipTime: 0.9,
  checkpointSpacing: 25,
};

// Collision points on the chassis (local coordinates).
// Two driven wheels plus a roof point so an upside-down car cannot sink.
const POINTS = [
  { lx: -1.2, ly: 0.36, r: 0.42, drive: 1 },
  { lx: 1.2, ly: 0.36, r: 0.42, drive: 0.4 },
  { lx: 0, ly: -0.55, r: 0.28, drive: 0 },
  { lx: -0.95, ly: -0.42, r: 0.24, drive: 0 },
  { lx: 0.95, ly: -0.42, r: 0.24, drive: 0 },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createCar(track, x = track.startX) {
  return {
    x,
    y: track.heightAt(x) - CAR.radius - CAR.wheelDrop - 0.25,
    angle: track.angleAt(x),
    vx: 0,
    vy: 0,
    omega: 0,
    wheelRot: 0,
    speed: 0,
    grounded: true,
    airTime: 0,
    flipTime: 0,
    checkpointX: x,
    bestX: x,
    throttle: 0,
  };
}

export function respawnCar(car, track, x = car.checkpointX) {
  const cx = Math.max(track.startX, x);
  car.x = cx;
  car.y = track.heightAt(cx) - CAR.radius - CAR.wheelDrop - 0.3;
  car.angle = track.angleAt(cx);
  car.vx = 0;
  car.vy = 0;
  car.omega = 0;
  car.flipTime = 0;
  car.airTime = 0;
  car.grounded = true;
}

function substep(car, input, track, dt) {
  const throttle = clamp(input.throttle || 0, -1, 1);
  car.throttle = throttle;

  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);

  let fx = 0;
  let fy = CAR.mass * CAR.gravity;
  let torque = 0;
  let wheelContacts = 0;
  let groundSpeedSum = 0;

  for (let i = 0; i < POINTS.length; i++) {
    const p = POINTS[i];
    const wx = car.x + cos * p.lx - sin * p.ly;
    const wy = car.y + sin * p.lx + cos * p.ly;

    const ground = track.heightAt(wx);
    const pen = wy + p.r - ground;
    if (pen <= 0) continue;
    if (p.drive > 0) wheelContacts++;

    const slope = track.slopeAt(wx);
    const nl = Math.hypot(1, slope);
    const nx = slope / nl; // surface normal pointing up (y is negative)
    const ny = -1 / nl;
    const tx = 1 / nl;
    const ty = slope / nl;

    const cx = wx - nx * p.r;
    const cy = wy - ny * p.r;
    const rx = cx - car.x;
    const ry = cy - car.y;

    const vcx = car.vx - car.omega * ry;
    const vcy = car.vy + car.omega * rx;

    const vn = vcx * nx + vcy * ny;
    const closing = Math.max(0, -vn);
    const compression = Math.min(pen, CAR.maxPenetration);
    const fn = clamp(CAR.spring * compression + CAR.damper * closing, 0, CAR.maxNormal);

    const vt = vcx * tx + vcy * ty;
    if (p.drive > 0) groundSpeedSum += vt;

    let ft = 0;
    if (p.drive > 0) {
      const speedFade = Math.max(0, 1 - Math.abs(vt) / CAR.maxSpeed);
      ft = throttle * CAR.drive * p.drive * speedFade - vt * CAR.rollResist;
      const maxTraction = CAR.grip * fn;
      ft = clamp(ft, -maxTraction, maxTraction);
    } else {
      // roof slides with a bit of friction
      ft = clamp(-vt * 60, -CAR.grip * fn, CAR.grip * fn);
    }

    const fnx = nx * fn;
    const fny = ny * fn;

    // Suspension force acts at the contact patch (this is what pitches the
    // car over bumps and landings). Drive force acts at the centre of mass so
    // the car does not instantly backflip when you touch the throttle.
    fx += fnx + tx * ft;
    fy += fny + ty * ft;
    torque += rx * fny - ry * fnx;
  }

  const upright = -Math.cos(car.angle) < -0.1;

  if (wheelContacts === 0) {
    // air control: gas lifts the nose, brake drops it
    car.omega -= throttle * CAR.airTorque * dt;
  } else if (upright) {
    // gently settle the chassis towards the slope angle
    const target = track.angleAt(car.x);
    let delta = target - car.angle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    torque += delta * CAR.alignTorque;
  }

  car.vx += (fx / CAR.mass) * dt;
  car.vy += (fy / CAR.mass) * dt;
  car.omega += (torque / CAR.inertia) * dt;
  if (wheelContacts === 0) {
    car.omega = clamp(car.omega, -CAR.maxSpin, CAR.maxSpin);
  }

  const dragK = 1 - CAR.drag * dt;
  car.vx *= dragK;
  car.vy *= dragK;
  car.omega *= 1 - CAR.angularDrag * dt;

  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.angle += car.omega * dt;

  car.grounded = wheelContacts > 0;
  car.airTime = wheelContacts > 0 ? 0 : car.airTime + dt;
  car.speed = Math.hypot(car.vx, car.vy);

  const wheelSpeed = wheelContacts > 0 ? groundSpeedSum / wheelContacts : car.vx;
  car.wheelRot += (wheelSpeed / CAR.radius) * dt;

  // auto-respawn when the car ends up on its roof
  const upY = -Math.cos(car.angle);
  if (wheelContacts > 0 && upY > 0.35) {
    car.flipTime += dt;
  } else {
    car.flipTime = 0;
  }
  if (car.flipTime > CAR.resetFlipTime) {
    respawnCar(car, track);
    return;
  }

  if (car.grounded && upY < -0.2 && car.x > car.checkpointX + CAR.checkpointSpacing) {
    car.checkpointX = car.x;
  }

  if (car.x > car.bestX) car.bestX = car.x;
  if (car.x < 0) {
    car.x = 0;
    car.vx = Math.max(0, car.vx);
  }
}

/** Advance a car by dt seconds (split into stable substeps). */
export function stepCar(car, input, track, dt) {
  const steps = 2;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) substep(car, input, track, h);
}

export function carSnapshot(car) {
  return {
    x: round(car.x),
    y: round(car.y),
    a: round(car.angle),
    w: round(car.wheelRot),
    v: round(car.speed),
    g: car.grounded ? 1 : 0,
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

