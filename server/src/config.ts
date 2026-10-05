import * as fs from "fs";
import * as path from "path";
import { PenaltyRules } from "./penalty/penaltyEngine";
import { PitZone } from "./instances/pitSpeeding";

export interface AppConfig {
  http: { port: number };
  acUdp: { localPort: number; remoteHost: string; remotePort: number };
  formation: { speedThresholdKmh: number; toleranceSeconds: number; penalty: PenaltyRules };
  pit: { zone: PitZone; legalPitSpeedKmh: number; stopGoSeconds: number; penalty: PenaltyRules };
}

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const defaultConfig: AppConfig = {
  http: { port: 3000 },
  acUdp: { localPort: 12000, remoteHost: "127.0.0.1", remotePort: 11000 },
  formation: {
    speedThresholdKmh: 80,
    toleranceSeconds: 5,
    penalty: {
      speedThresholdKmh: 80,
      toleranceSeconds: 5,
      graceLaps: 1,
      penaltyType: "DT",
      escalation: "DQ",
      ballastKg: 50,
    },
  },
  pit: {
    zone: { splineStart: 0.97, splineEnd: 0.995 },
    legalPitSpeedKmh: 80,
    stopGoSeconds: 30,
    penalty: {
      speedThresholdKmh: 80,
      toleranceSeconds: 5,
      graceLaps: 1,
      penaltyType: "DT",
      escalation: "DQ",
      ballastKg: 50,
    },
  },
};

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return { ...defaultConfig, ...raw };
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
