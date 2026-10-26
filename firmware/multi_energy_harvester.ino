// =====================================================
//  MULTI-ENERGY HARVESTER + SELF-CLEANING  v3.1
//  Solar (real charging, measured by INA219)
//  Wind  (DC motor generator, measured across 200 ohm load)
//  Piezo (footstep tile -> bridge -> capacitor, steps + energy)
//  Cleaner: bright light BUT low solar current = dirty panel
//           -> vibration motor runs a cleaning cycle via L298N
// =====================================================
//  Library: Sketch > Include Library > Manage Libraries
//           search "Adafruit INA219" > Install (accept BusIO too)
// =====================================================

#include <Wire.h>
#include <Adafruit_INA219.h>

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
const float STEP_JUMP_V = 0.08;     // tune: ~half the rise per step
#define PIEZO_CONNECTED false        // set true once the piezo discs are attached

// ---------- Solar ----------
const float SOLAR_ON_MA = 1.0;

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
float lastCapV = 0;

float solarV = 0, solarmA = 0, solarmW = 0;
float windV = 0, windmW = 0;
float capV = 0;
int   ldrRaw = 0;

enum CleanState { IDLE, CLEANING, COOLDOWN };
CleanState cleanState = IDLE;
unsigned long cleanStateSince = 0, dirtySince = 0;
unsigned long cleanCycles = 0;

unsigned long lastSample = 0, lastPrint = 0, piezoLedUntil = 0;

float pinVolts(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(pin);
  return (sum / 8.0) / 1000.0;
}

const char* lightText() {
  if (ldrRaw > LDR_NIGHT)  return "NIGHT";
  if (ldrRaw < LDR_BRIGHT) return "BRIGHT";
  return "DIM";
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
  inaOk = ina.begin();
  if (inaOk) ina.setCalibration_16V_400mA();

  Serial.println("=====================================");
  Serial.println(" MULTI-ENERGY HARVESTER + CLEANER v3.1");
  Serial.println("=====================================");
  if (!inaOk) Serial.println("!! INA219 NOT FOUND - check SDA/SCL/VCC/GND");

  // Lamp + motor test (1 s)
  digitalWrite(SOLAR_LED, HIGH); digitalWrite(WIND_LED, HIGH);
  digitalWrite(PIEZO_LED, HIGH); digitalWrite(STATUS_LED, HIGH);
  digitalWrite(CLEAN_PIN, HIGH);
  delay(1000);
  digitalWrite(SOLAR_LED, LOW);  digitalWrite(WIND_LED, LOW);
  digitalWrite(PIEZO_LED, LOW);  digitalWrite(STATUS_LED, LOW);
  digitalWrite(CLEAN_PIN, LOW);

  lastCapV   = pinVolts(PIEZO_PIN) * PIEZO_DIV;
  lastSample = millis();
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

void loop() {
  unsigned long now = millis();

  if (now - lastSample >= 50) {
    float dt_h = (now - lastSample) / 3600000.0;
    lastSample = now;

    // LIGHT
    ldrRaw = analogRead(LDR_PIN);

    // SOLAR
    if (inaOk) {
      solarV  = ina.getBusVoltage_V();
      solarmA = ina.getCurrent_mA();
      if (solarmA < 0) solarmA = 0;
      solarmW = solarV * solarmA;
      solar_mWh += solarmW * dt_h;
    }

    // WIND
    windV  = pinVolts(WIND_PIN) * WIND_DIV;
    windmW = (windV * windV / WIND_LOAD_OHMS) * 1000.0;
    if (windV < WIND_ON_V) windmW = 0;
    wind_mWh += windmW * dt_h;

    // PIEZO (skipped until discs are attached, so noise can't fake steps)
    capV = PIEZO_CONNECTED ? pinVolts(PIEZO_PIN) * PIEZO_DIV : 0;
    if (PIEZO_CONNECTED && capV - lastCapV > STEP_JUMP_V) {
      steps++;
      piezo_uJ += 0.5 * PIEZO_CAP_F * (capV * capV - lastCapV * lastCapV) * 1e6;
      piezoLedUntil = now + 300;
    }
    lastCapV = capV;

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

    Serial.println("=====================================");
    Serial.println(" MULTI-ENERGY HARVESTER + CLEANER v3.1");
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
    else Serial.printf("PIEZO : cap %.2f V  steps %lu  %.1f uJ total\n",
                  capV, steps, piezo_uJ);

    if (STORAGE_IS_BATTERY) {
      // rough Li-ion estimate: 3.0 V = 0%, 4.2 V = 100%
      int pct = (int)((scapV - 3.0) / (4.2 - 3.0) * 100.0);
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      char bar[11];
      for (int i = 0; i < 10; i++) bar[i] = (i < pct / 10) ? '#' : '-';
      bar[10] = '\0';
      Serial.printf("STORE : battery %.2f V  [%s] ~%d%%  %s\n", scapV, bar, pct,
                    solarmA > SOLAR_ON_MA ? "charging" : "");
    } else {
      int pct = (int)(100.0 * (scapV * scapV) / (SCAP_FULL_V * SCAP_FULL_V));
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      char bar[11];
      for (int i = 0; i < 10; i++) bar[i] = (i < pct / 10) ? '#' : '-';
      bar[10] = '\0';
      Serial.printf("STORE : supercap %.2f V  %.2f J  [%s] %d%%\n", scapV, scapJ, bar, pct);
    }

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

    // ---- JSON line for the web dashboard (dashboard.html) ----
    int storePct;
    if (STORAGE_IS_BATTERY) storePct = (int)((scapV - 3.0) / (4.2 - 3.0) * 100.0);
    else                    storePct = (int)(100.0 * (scapV * scapV) / (SCAP_FULL_V * SCAP_FULL_V));
    if (storePct < 0) storePct = 0;
    if (storePct > 100) storePct = 100;

    const char* panel = (cleanState == CLEANING) ? "CLEANING" :
                        (cleanState == COOLDOWN) ? "COOLDOWN" :
                        (dirtySince != 0)        ? "CHECKING" :
                        (ldrRaw > LDR_NIGHT)     ? "NIGHT"    : "CLEAN";

    Serial.printf("{\"ldr\":%d,\"light\":\"%s\",\"ina\":%d,"
                  "\"sV\":%.2f,\"smA\":%.1f,\"smW\":%.1f,"
                  "\"wV\":%.2f,\"wmW\":%.2f,"
                  "\"cV\":%.2f,\"steps\":%lu,\"puJ\":%.1f,"
                  "\"bV\":%.2f,\"bPct\":%d,"
                  "\"panel\":\"%s\",\"cycles\":%lu,"
                  "\"smWh\":%.4f,\"wmWh\":%.4f}\n",
                  ldrRaw, lightText(), inaOk ? 1 : 0,
                  solarV, solarmA, solarmW,
                  windV, windmW,
                  capV, steps, piezo_uJ,
                  scapV, storePct,
                  panel, cleanCycles,
                  solar_mWh, wind_mWh);
  }
}
