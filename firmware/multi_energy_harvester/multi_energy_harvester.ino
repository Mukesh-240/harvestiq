// =====================================================
//  SOLAR + WIND + PIEZO HARVESTER + SELF-CLEANING   v3.2
//  For the HARVESTIQ dashboard (USB serial, 115200 baud)
//  Solar   : real charging, measured by INA219
//  Wind    : DC motor generator, measured across 200 ohm load
//  Piezo   : footstep tile -> bridge -> 470uF cap -> divider -> D32
//  Battery : 18650 voltage read through 100k/100k divider
//  Cleaner : bright light BUT low solar current = dirty panel
//            -> vibration motor runs a cleaning cycle via L298N
//
//  Improvements over the plain solar + wind sketch
//   - INA219 re-checked every 0.5 s, not only at boot. A loose INA219 reads
//     0 mA, which in bright light looked "dirty" and ran the motor for
//     nothing. Now it reports ina:0, the cleaner is blocked, and the sensor
//     is re-initialised automatically when it comes back.
//   - Piezo: a step = quick rise above a slow (~1 s) baseline, with a 400 ms
//     lockout so press + release of one footstep = ONE step. The log shows
//     "peak rise" every second: tap the tile, set STEP_JUMP_V to ~half of it.
//   - JSON sends "pz" (piezo enabled), so the dashboard needs no checkbox.
//   - NaN / inf can never reach the JSON (the dashboard would drop the line).
//   - Switches: HUMAN_LOG, BOOT_SELF_TEST, PIN_FINDER.
//   - The firmware accepts NO incoming commands.
// =====================================================
//  Library: Sketch > Include Library > Manage Libraries
//           search "Adafruit INA219" > Install (accept BusIO too)
// =====================================================

#include <Wire.h>
#include <Adafruit_INA219.h>

#define FW_VERSION "3.2"

// ---------- Switches ----------
const bool HUMAN_LOG      = true;   // false = JSON line only (quieter console)
const bool BOOT_SELF_TEST = true;   // 1 s LED + motor test after every reset
                                    // (opening the dashboard's port resets the ESP32)
const bool PIN_FINDER     = false;  // true = also print spare analog pins (find the piezo wire)

// ---------- Pins ----------
#define LDR_PIN     34   // LDR module AO
#define WIND_PIN    35   // wind divider node
#define BATT_PIN    33   // battery divider node
#define PIEZO_PIN   32   // piezo divider node (change if PIN_FINDER shows another pin)
#define CLEAN_PIN   25   // L298N IN1
#define STATUS_LED  26   // on while cleaning
#define SOLAR_LED   27
#define WIND_LED    14
#define PIEZO_LED   12   // flashes on each step (harmless if no LED is fitted)
// INA219: SDA = D21, SCL = D22

// ---------- Light (LDR reads HIGH in dark, LOW in bright) ----------
const int LDR_BRIGHT = 1500;   // below this = bright  (calibrate)
const int LDR_NIGHT  = 3000;   // above this = night

// ---------- Cleaner ----------
const float DIRTY_MA                 = 3.0;   // bright but solar below this = dirty
const unsigned long CLEAN_MS         = 5000;  // motor run time per cycle
const unsigned long COOLDOWN_MS      = 8000;  // wait before re-checking
const unsigned long DIRTY_CONFIRM_MS = 2000;  // must stay dirty this long

// ---------- Wind ----------
// motor + -> 1N4007 -> 100R -> NODE -> 100R -> GND ; NODE -> D35
const float WIND_DIV       = 2.0;
const float WIND_LOAD_OHMS = 200.0;
const float WIND_ON_V      = 0.30;

// ---------- Piezo ----------
// piezo -> bridge (4x 1N4007) -> 470uF cap
// cap + -> 100k -> NODE -> 22k -> GND ; NODE -> D32 ; 2 red LEDs in series NODE->GND (clamp)
#define PIEZO_CONNECTED true                 // false = channel off (sent as pz:0)
const float PIEZO_DIV   = (100.0 + 22.0) / 22.0;
const float PIEZO_CAP_F = 470e-6;            // 470uF
const float STEP_JUMP_V = 0.08;              // rise (cap volts) that counts as a step:
                                             // ~half the "peak rise" one tap shows
const unsigned long STEP_LOCKOUT_MS = 400;   // press + release of one footstep = one step
const float PIEZO_BASE_FOLLOW = 0.05;        // baseline speed (~1 s at 50 ms samples)
const int SPARE_ADC_PINS[] = {32, 36, 39, 4, 13, 15};   // printed by PIN_FINDER

// ---------- Solar ----------
const float SOLAR_ON_MA = 0.05;              // LED / "CHARGING" threshold
const unsigned long INA_PROBE_MS = 500;      // how often the INA219 is re-checked

// ---------- Battery ----------
// B+ -> 100k -> NODE -> 100k -> GND ; NODE -> D33
const float BATT_DIV = 2.0;

// ---------- State ----------
Adafruit_INA219 ina;
bool inaOk = false;

float solarV = 0, solarmA = 0, solarmW = 0, solar_mWh = 0;
float windV = 0, windmW = 0, wind_mWh = 0;
float battV = 0;
int   battPct = 0;
int   ldrRaw = 0;

float capV = 0, piezo_uJ = 0;
float piezoBaseV = 0;          // slow baseline of the capacitor voltage
float piezoPeakRiseV = 0;      // largest rise above baseline since the last print
unsigned long steps = 0, lastStepAt = 0, piezoLedUntil = 0;

enum CleanState { IDLE, CLEANING, COOLDOWN };
CleanState cleanState = IDLE;
unsigned long cleanStateSince = 0, dirtySince = 0, cleanCycles = 0;

unsigned long lastSample = 0, lastPrint = 0, lastInaProbe = 0;

// (No default arguments: the Arduino IDE's auto-generated prototypes can choke on them.)
float pinVoltsN(int pin, int samples) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; i++) sum += analogReadMilliVolts(pin);
  return (sum / (float)samples) / 1000.0;
}

float pinVolts(int pin) { return pinVoltsN(pin, 8); }

const char* lightText() {
  if (ldrRaw > LDR_NIGHT)  return "NIGHT";
  if (ldrRaw < LDR_BRIGHT) return "BRIGHT";
  return "DIM";
}

// True if something acknowledges the INA219 address (cheap, ~0.2 ms).
bool inaPresent() {
  Wire.beginTransmission(INA219_ADDRESS);
  return Wire.endTransmission() == 0;
}

// Keeps inaOk true only while the INA219 is really there; re-initialises it when it returns.
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

void readSolar(float dt_h) {
  if (inaOk) {
    solarV  = ina.getBusVoltage_V();
    solarmA = ina.getCurrent_mA();
    if (isnan(solarV) || isnan(solarmA) || isinf(solarV) || isinf(solarmA)) {
      inaOk = false;                 // a bad read is treated like a lost sensor
    } else {
      if (solarmA < 0) solarmA = 0;
      solarmW = solarV * solarmA;
      solar_mWh += solarmW * dt_h;
    }
  }
  if (!inaOk) { solarV = 0; solarmA = 0; solarmW = 0; }   // placeholders; ina:0 tells the dashboard
}

// A footstep charges the 470 uF cap a little; it then leaks away slowly
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

void setLeds(bool on) {
  digitalWrite(SOLAR_LED, on);  digitalWrite(WIND_LED, on);
  digitalWrite(PIEZO_LED, on);  digitalWrite(STATUS_LED, on);
  digitalWrite(CLEAN_PIN, on);
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(SOLAR_LED, OUTPUT);
  pinMode(WIND_LED, OUTPUT);
  pinMode(PIEZO_LED, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);
  pinMode(CLEAN_PIN, OUTPUT);
  digitalWrite(CLEAN_PIN, LOW);

  Wire.begin(21, 22);
  Wire.setTimeOut(20);   // a stuck I2C bus must not freeze the loop
  inaOk = inaPresent() && ina.begin();
  if (inaOk) ina.setCalibration_16V_400mA();

  Serial.println("=====================================");
  Serial.println("  SOLAR + WIND + PIEZO HARVESTER v" FW_VERSION);
  Serial.println("=====================================");
  if (!inaOk) Serial.println("!! INA219 NOT FOUND - check SDA/SCL/VCC/GND");

  if (BOOT_SELF_TEST) {   // lamp + motor test (1 s)
    setLeds(HIGH);
    delay(1000);
    setLeds(LOW);
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
  Serial.println("  SOLAR + WIND + PIEZO HARVESTER v" FW_VERSION);
  Serial.println("=====================================");

  Serial.printf("LIGHT : %s (LDR raw %d)\n", lightText(), ldrRaw);

  Serial.print("SOLAR : ");
  if (!inaOk) Serial.println("INA219 missing");
  else Serial.printf("%.2f V  %.1f mA  %.1f mW  %s\n",
                     solarV, solarmA, solarmW,
                     solarmA > SOLAR_ON_MA ? "CHARGING" : "idle");

  Serial.printf("WIND  : %.2f V  %.2f mW  %s\n",
                windV, windmW, windV > WIND_ON_V ? "GENERATING" : "idle");

  if (!PIEZO_CONNECTED) Serial.println("PIEZO : not attached");
  else Serial.printf("PIEZO : cap %.2f V (D%d node %.3f V)  steps %lu  %.1f uJ  peak rise %.3f V (step if > %.2f)\n",
                     capV, PIEZO_PIN, capV / PIEZO_DIV, steps, piezo_uJ,
                     piezoPeakRiseV, STEP_JUMP_V);

  if (PIN_FINDER) {
    // Tap the tile: the pin whose voltage jumps is where the piezo divider is wired.
    Serial.print("PINS  :");
    for (int p : SPARE_ADC_PINS) Serial.printf("  D%d %.3f V", p, pinVolts(p));
    Serial.println();
  }

  char bar[11];
  for (int i = 0; i < 10; i++) bar[i] = (i < battPct / 10) ? '#' : '-';
  bar[10] = '\0';
  Serial.printf("BATT  : %.2f V  [%s] ~%d%%  %s\n", battV, bar, battPct,
                solarmA > SOLAR_ON_MA ? "charging" : "");

  Serial.print("PANEL : ");
  if (cleanState == CLEANING)      Serial.println("DIRTY -> CLEANING NOW");
  else if (cleanState == COOLDOWN) Serial.println("cleaned, re-checking...");
  else if (dirtySince != 0)        Serial.println("low output in bright light - confirming...");
  else if (ldrRaw > LDR_NIGHT)     Serial.println("night - cleaner idle");
  else                             Serial.println("clean");
  Serial.printf("        cleaning cycles: %lu\n", cleanCycles);

  Serial.println("------------- TOTALS ----------------");
  Serial.printf("Solar %.4f mWh | Wind %.4f mWh | Piezo %.1f uJ\n", solar_mWh, wind_mWh, piezo_uJ);
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
                battV, battPct,
                panel, cleanCycles,
                solar_mWh, wind_mWh);
}

void loop() {
  unsigned long now = millis();

  // ---------- Sampling every 50 ms ----------
  if (now - lastSample >= 50) {
    float dt_h = (now - lastSample) / 3600000.0;
    lastSample = now;

    // LIGHT
    ldrRaw = analogRead(LDR_PIN);

    // SOLAR (INA219 re-checked every INA_PROBE_MS)
    checkIna(now);
    readSolar(dt_h);

    // WIND  (P = V^2 / R)
    windV  = pinVolts(WIND_PIN) * WIND_DIV;
    windmW = (windV * windV / WIND_LOAD_OHMS) * 1000.0;
    if (windV < WIND_ON_V) windmW = 0;
    wind_mWh += windmW * dt_h;

    // PIEZO (skipped when not attached, so noise can't fake steps)
    if (PIEZO_CONNECTED) readPiezo(now);

    // BATTERY  (3.0 V = 0%, 4.2 V = 100%)
    battV   = pinVolts(BATT_PIN) * BATT_DIV;
    battPct = constrain((int)((battV - 3.0) / (4.2 - 3.0) * 100.0), 0, 100);

    // CLEANER
    runCleaner(now);

    // LEDs
    digitalWrite(SOLAR_LED, solarmA > SOLAR_ON_MA ? HIGH : LOW);
    digitalWrite(WIND_LED,  windV   > WIND_ON_V   ? HIGH : LOW);
    digitalWrite(PIEZO_LED, now < piezoLedUntil   ? HIGH : LOW);
  }

  // ---------- Print every 1 s ----------
  if (now - lastPrint >= 1000) {
    lastPrint = now;
    if (HUMAN_LOG) printHumanLog();
    printJson();
    piezoPeakRiseV = 0;   // "peak rise" is per second
  }
}
