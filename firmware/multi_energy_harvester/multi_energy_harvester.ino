// =====================================================
//  MULTI-ENERGY HARVESTER + SELF-CLEANING  v3.2
//  Drop-in upgrade of v3.1 for the HARVESTIQ dashboard.
//  Same pins, same wiring, same cleaning logic, same JSON fields.
//
//  What is new in v3.2
//   1. JSON reports "pz" (1 = piezo enabled), so the dashboard no longer
//      needs the "Piezo attached" checkbox.
//   2. INA219 is re-checked twice a second, not only at boot:
//        - unplugged / lost I2C  -> "ina":0 within 0.5 s, cleaner is blocked
//        - plugged back in       -> re-initialised automatically, "ina":1
//      (v3.1 kept using the last values, and a dead INA219 reads 0 mA, which
//       in bright light looked like a dirty panel and started cleaning.)
//   3. NaN / inf can never reach the JSON line (it would be rejected as
//      malformed by the dashboard).
//   4. HUMAN_LOG and BOOT_SELF_TEST switches (below).
//   5. Piezo ENABLED (discs on D32) with sturdier step counting:
//        - a step = quick rise above a slow (~1 s) baseline, so a rise spread
//          over two samples is still caught and ADC noise is averaged out
//        - 400 ms lockout, so press + release of one footstep = ONE step
//        - the log prints "peak rise" every second: tap the tile and set
//          STEP_JUMP_V to about half of what you see
//   6. PIN_FINDER switch: prints the spare analog pins every second, to find
//      which pin the piezo is really wired to.
//
//  Library: Sketch > Include Library > Manage Libraries
//           search "Adafruit INA219" > Install (accept BusIO too)
//  Serial:  115200 baud. The firmware accepts NO incoming commands.
// =====================================================

#include <Wire.h>
#include <Adafruit_INA219.h>

#define FW_VERSION "3.2"

// ---------- Output options ----------
const bool HUMAN_LOG      = true;   // false = JSON line only (quieter console)
const bool BOOT_SELF_TEST = true;   // 1 s LED + motor test after every reset
                                    // (opening the dashboard's port resets the ESP32)
const bool PIN_FINDER     = false;  // true = also print spare ADC pins (find the piezo wire)

// ---------- Pins ----------
#define LDR_PIN     34   // LDR module AO
#define WIND_PIN    35   // wind divider node
#define PIEZO_PIN   32   // piezo divider node
#define CLEAN_PIN   25   // L298N IN1
#define STATUS_LED  26   // on while cleaning
#define SOLAR_LED   27
#define WIND_LED    14
#define PIEZO_LED   12
// INA219: SDA = D21, SCL = D22 (ESP32 defaults)

// ---------- Light (LDR reads HIGH in dark, LOW in bright) ----------
const int LDR_BRIGHT = 1500;   // below this = bright  (calibrate with RAW line)
const int LDR_NIGHT  = 3000;   // above this = night

// ---------- Cleaner ----------
const float DIRTY_MA        = 3.0;    // bright but solar below this = dirty
const unsigned long CLEAN_MS    = 5000;   // motor run time per cycle
const unsigned long COOLDOWN_MS = 8000;   // wait before re-checking
const unsigned long DIRTY_CONFIRM_MS = 2000; // must stay dirty this long

// ---------- Wind circuit ----------
// motor + -> 1N4007 -> 100R -> NODE -> 100R -> GND ; NODE -> D35
const float WIND_DIV       = 2.0;
const float WIND_LOAD_OHMS = 200.0;
const float WIND_ON_V      = 0.30;

// ---------- Piezo circuit ----------
// piezo -> bridge (4x 1N4007) -> 470uF cap
// cap + -> 100k -> NODE -> 22k -> GND ; NODE -> D32 ; 2 red LEDs in series NODE->GND (clamp)
const float PIEZO_DIV   = (100.0 + 22.0) / 22.0;
const float PIEZO_CAP_F = 470e-6;   // 470uF 63V
const float STEP_JUMP_V = 0.08;     // rise (cap volts) that counts as a step.
                                    // Tune: ~half the "peak rise" the log shows per tap
const unsigned long STEP_LOCKOUT_MS = 400;  // one footstep (press + release) = one step
const float PIEZO_BASE_FOLLOW = 0.05;       // baseline speed (~1 s at 50 ms samples)
#define PIEZO_CONNECTED true         // discs attached; false = channel off (sent as pz:0)
// Unused analog-capable pins that PIN_FINDER prints (not used by this build).
const int SPARE_ADC_PINS[] = {32, 36, 39, 4, 13, 15};

// ---------- Solar ----------
const float SOLAR_ON_MA = 1.0;
const unsigned long INA_PROBE_MS = 500;   // how often the INA219 is re-checked

// ---------- Storage (18650 battery or supercap) ----------
// storage + -> 100k -> NODE -> 100k -> GND ; NODE -> D33
#define STORAGE_IS_BATTERY true   // false if you use a supercap
#define SCAP_PIN 33
const float SCAP_DIV    = 2.0;
const float SCAP_F      = 1.0;   // set to your supercap's farads (e.g. 0.47)
const float SCAP_FULL_V = 4.2;   // TP4056 stops here
float scapV = 0, scapJ = 0;

// ---------- State ----------
Adafruit_INA219 ina;
bool inaOk = false;

float solar_mWh = 0, wind_mWh = 0, piezo_uJ = 0;
unsigned long steps = 0;
float piezoBaseV = 0;        // slow baseline of the capacitor voltage
float piezoPeakRiseV = 0;    // largest rise above baseline since the last print
unsigned long lastStepAt = 0;

float solarV = 0, solarmA = 0, solarmW = 0;
float windV = 0, windmW = 0;
float capV = 0;
int   ldrRaw = 0;

enum CleanState { IDLE, CLEANING, COOLDOWN };
CleanState cleanState = IDLE;
unsigned long cleanStateSince = 0, dirtySince = 0;
unsigned long cleanCycles = 0;

unsigned long lastSample = 0, lastPrint = 0, piezoLedUntil = 0, lastInaProbe = 0;

// (No default arguments: the Arduino IDE's auto-generated prototypes can choke on them.)
float pinVoltsN(int pin, int samples) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; i++) sum += analogReadMilliVolts(pin);
  return (sum / (float)samples) / 1000.0;
}

float pinVolts(int pin) { return pinVoltsN(pin, 8); }

// PIEZO: a footstep charges the 470 uF cap a little; it then leaks away slowly
// through the 122k divider (~1 min). A step is a QUICK rise above a slow baseline.
void readPiezo(unsigned long now) {
  capV = pinVoltsN(PIEZO_PIN, 32) * PIEZO_DIV;   // 32 samples: the per-step rise is small
  float rise = capV - piezoBaseV;
  if (rise > piezoPeakRiseV) piezoPeakRiseV = rise;

  bool inLockout = steps > 0 && now - lastStepAt < STEP_LOCKOUT_MS;  // no lockout before the first step
  bool stepNow = !inLockout && rise > STEP_JUMP_V;
  if (stepNow) {
    steps++;
    lastStepAt = now;
    piezoLedUntil = now + 300;
  }

  if (rise > 0 && (inLockout || stepNow)) {
    // Energy added to the cap by this footstep (press and release), then re-arm.
    piezo_uJ += 0.5 * PIEZO_CAP_F * (capV * capV - piezoBaseV * piezoBaseV) * 1e6;
    piezoBaseV = capV;
  } else {
    piezoBaseV += (capV - piezoBaseV) * PIEZO_BASE_FOLLOW;   // follows noise and slow leak
  }
}

const char* lightText() {
  if (ldrRaw > LDR_NIGHT)  return "NIGHT";
  if (ldrRaw < LDR_BRIGHT) return "BRIGHT";
  return "DIM";
}

// Rough storage level: Li-ion 3.0 V = 0 %, 4.2 V = 100 %; supercap by energy.
int storePercent() {
  int pct = STORAGE_IS_BATTERY
              ? (int)((scapV - 3.0) / (4.2 - 3.0) * 100.0)
              : (int)(100.0 * (scapV * scapV) / (SCAP_FULL_V * SCAP_FULL_V));
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// True if something acknowledges the INA219 address (cheap, ~0.2 ms).
bool inaPresent() {
  Wire.beginTransmission(INA219_ADDRESS);
  return Wire.endTransmission() == 0;
}

// Keeps "inaOk" true only while the INA219 is really there, and
// re-initialises it when it comes back.
void checkIna(unsigned long now) {
  if (now - lastInaProbe < INA_PROBE_MS) return;
  lastInaProbe = now;

  bool present = inaPresent();
  if (inaOk && !present) {
    inaOk = false;
    Serial.println("!! INA219 LOST - solar reading unavailable, cleaner blocked");
  } else if (!inaOk && present && ina.begin()) {
    ina.setCalibration_16V_400mA();
    inaOk = true;
    Serial.println("INA219 detected - solar reading restored");
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(SOLAR_LED, OUTPUT);
  pinMode(WIND_LED,  OUTPUT);
  pinMode(PIEZO_LED, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);
  pinMode(CLEAN_PIN, OUTPUT);
  digitalWrite(CLEAN_PIN, LOW);

  Wire.begin(21, 22);
  Wire.setTimeOut(20);   // a stuck I2C bus must not freeze the loop
  inaOk = inaPresent() && ina.begin();
  if (inaOk) ina.setCalibration_16V_400mA();

  Serial.println("=====================================");
  Serial.println(" MULTI-ENERGY HARVESTER + CLEANER v" FW_VERSION);
  Serial.println("=====================================");
  if (!inaOk) Serial.println("!! INA219 NOT FOUND - check SDA/SCL/VCC/GND");

  if (BOOT_SELF_TEST) {
    digitalWrite(SOLAR_LED, HIGH); digitalWrite(WIND_LED, HIGH);
    digitalWrite(PIEZO_LED, HIGH); digitalWrite(STATUS_LED, HIGH);
    digitalWrite(CLEAN_PIN, HIGH);
    delay(1000);
    digitalWrite(SOLAR_LED, LOW);  digitalWrite(WIND_LED, LOW);
    digitalWrite(PIEZO_LED, LOW);  digitalWrite(STATUS_LED, LOW);
    digitalWrite(CLEAN_PIN, LOW);
  }

  piezoBaseV   = PIEZO_CONNECTED ? pinVoltsN(PIEZO_PIN, 32) * PIEZO_DIV : 0;  // no false step at boot
  lastSample   = millis();
  lastInaProbe = lastSample;
}

void runCleaner(unsigned long now) {
  bool bright = ldrRaw < LDR_BRIGHT;
  bool dirty  = inaOk && bright && solarmA < DIRTY_MA;

  switch (cleanState) {
    case IDLE:
      if (dirty) {
        if (dirtySince == 0) dirtySince = now;
        if (now - dirtySince >= DIRTY_CONFIRM_MS) {
          cleanState = CLEANING;
          cleanStateSince = now;
          cleanCycles++;
          dirtySince = 0;
        }
      } else {
        dirtySince = 0;
      }
      break;

    case CLEANING:
      if (now - cleanStateSince >= CLEAN_MS) {
        cleanState = COOLDOWN;
        cleanStateSince = now;
      }
      break;

    case COOLDOWN:
      if (now - cleanStateSince >= COOLDOWN_MS) cleanState = IDLE;
      break;
  }

  bool motorOn = (cleanState == CLEANING);
  digitalWrite(CLEAN_PIN,  motorOn ? HIGH : LOW);
  digitalWrite(STATUS_LED, motorOn ? HIGH : LOW);
}

void printHumanLog() {
  Serial.println("=====================================");
  Serial.println(" MULTI-ENERGY HARVESTER + CLEANER v" FW_VERSION);
  Serial.println("=====================================");

  Serial.printf("LIGHT : %s (LDR raw %d)\n", lightText(), ldrRaw);

  Serial.print("SOLAR : ");
  if (!inaOk) Serial.println("INA219 missing");
  else Serial.printf("%.2f V  %.1f mA  %.1f mW  %s\n",
                     solarV, solarmA, solarmW,
                     solarmA > SOLAR_ON_MA ? "CHARGING" : "idle");

  Serial.printf("WIND  : %.2f V  %.2f mW  %s\n",
                windV, windmW, windV > WIND_ON_V ? "GENERATING" : "idle");

  if (!PIEZO_CONNECTED) Serial.println("PIEZO : not attached yet");
  else Serial.printf("PIEZO : cap %.2f V (D%d node %.3f V)  steps %lu  %.1f uJ  peak rise %.3f V (step if > %.2f)\n",
                     capV, PIEZO_PIN, capV / PIEZO_DIV, steps, piezo_uJ,
                     piezoPeakRiseV, STEP_JUMP_V);

  if (PIN_FINDER) {
    // Tap the tile: the pin whose voltage jumps is where the piezo divider is wired.
    Serial.print("PINS  :");
    for (int p : SPARE_ADC_PINS) Serial.printf("  D%d %.3f V", p, pinVolts(p));
    Serial.println();
  }

  int pct = storePercent();
  char bar[11];
  for (int i = 0; i < 10; i++) bar[i] = (i < pct / 10) ? '#' : '-';
  bar[10] = '\0';
  if (STORAGE_IS_BATTERY)
    Serial.printf("STORE : battery %.2f V  [%s] ~%d%%  %s\n", scapV, bar, pct,
                  solarmA > SOLAR_ON_MA ? "charging" : "");
  else
    Serial.printf("STORE : supercap %.2f V  %.2f J  [%s] %d%%\n", scapV, scapJ, bar, pct);

  Serial.print("PANEL : ");
  if (cleanState == CLEANING)      Serial.println("DIRTY -> CLEANING NOW");
  else if (cleanState == COOLDOWN) Serial.println("cleaned, re-checking...");
  else if (dirtySince != 0)        Serial.println("low output in bright light - confirming...");
  else if (ldrRaw > LDR_NIGHT)     Serial.println("night - cleaner idle");
  else                             Serial.println("clean");
  Serial.printf("        cleaning cycles: %lu\n", cleanCycles);

  Serial.println("------------- TOTALS ----------------");
  Serial.printf("Solar %.4f mWh | Wind %.4f mWh | Piezo %.1f uJ\n",
                solar_mWh, wind_mWh, piezo_uJ);
  Serial.println();
}

// One JSON line for the HARVESTIQ dashboard. Field names are the contract.
void printJson() {
  const char* panel = (cleanState == CLEANING) ? "CLEANING" :
                      (cleanState == COOLDOWN) ? "COOLDOWN" :
                      (dirtySince != 0)        ? "CHECKING" :
                      (ldrRaw > LDR_NIGHT)     ? "NIGHT"    : "CLEAN";

  Serial.printf("{\"ldr\":%d,\"light\":\"%s\",\"ina\":%d,"
                "\"sV\":%.2f,\"smA\":%.1f,\"smW\":%.1f,"
                "\"wV\":%.2f,\"wmW\":%.2f,"
                "\"cV\":%.2f,\"steps\":%lu,\"puJ\":%.1f,\"pz\":%d,"
                "\"bV\":%.2f,\"bPct\":%d,"
                "\"panel\":\"%s\",\"cycles\":%lu,"
                "\"smWh\":%.4f,\"wmWh\":%.4f}\n",
                ldrRaw, lightText(), inaOk ? 1 : 0,
                solarV, solarmA, solarmW,
                windV, windmW,
                capV, steps, piezo_uJ, PIEZO_CONNECTED ? 1 : 0,
                scapV, storePercent(),
                panel, cleanCycles,
                solar_mWh, wind_mWh);
}

void loop() {
  unsigned long now = millis();

  if (now - lastSample >= 50) {
    float dt_h = (now - lastSample) / 3600000.0;
    lastSample = now;

    // LIGHT
    ldrRaw = analogRead(LDR_PIN);

    // SOLAR (INA219 is re-checked every INA_PROBE_MS)
    checkIna(now);
    if (inaOk) {
      solarV  = ina.getBusVoltage_V();
      solarmA = ina.getCurrent_mA();
      if (isnan(solarV) || isnan(solarmA) || isinf(solarV) || isinf(solarmA)) inaOk = false;
      else {
        if (solarmA < 0) solarmA = 0;
        solarmW = solarV * solarmA;
        solar_mWh += solarmW * dt_h;
      }
    }
    if (!inaOk) { solarV = 0; solarmA = 0; solarmW = 0; }   // placeholders, ina:0 tells the dashboard

    // WIND
    windV  = pinVolts(WIND_PIN) * WIND_DIV;
    windmW = (windV * windV / WIND_LOAD_OHMS) * 1000.0;
    if (windV < WIND_ON_V) windmW = 0;
    wind_mWh += windmW * dt_h;

    // PIEZO (skipped when not attached, so noise can't fake steps)
    if (PIEZO_CONNECTED) readPiezo(now);
    else capV = 0;

    // STORAGE voltage (battery or supercap)
    scapV = pinVolts(SCAP_PIN) * SCAP_DIV;
    scapJ = 0.5 * SCAP_F * scapV * scapV;

    // CLEANER
    runCleaner(now);

    // LEDs
    digitalWrite(SOLAR_LED, solarmA > SOLAR_ON_MA ? HIGH : LOW);
    digitalWrite(WIND_LED,  windV   > WIND_ON_V   ? HIGH : LOW);
    digitalWrite(PIEZO_LED, now < piezoLedUntil   ? HIGH : LOW);
  }

  if (now - lastPrint >= 1000) {
    lastPrint = now;
    if (HUMAN_LOG) printHumanLog();
    printJson();
    piezoPeakRiseV = 0;   // "peak rise" is per second
  }
}
