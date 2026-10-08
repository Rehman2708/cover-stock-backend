const DEFAULT_BASE_URL = "https://api.mobileapi.dev";

export interface MobileApiDevice {
  id: number;
  name: string;
  brand?: { name?: string } | string;
  manufacturer?: { name?: string } | string;
  manufacturer_name?: string;
  brand_name?: string;
  model_numbers?: string;
  description?: string;
  screen_resolution?: string;
  camera?: string;
  hardware?: string;
  battery_capacity?: string | number;
  storage?: string;
  weight?: string;
  thickness?: string;
  colors?: string;
  release_date?: string;
  device_type?: string;
  image_url?: string;
  image_b64?: string;
  main_image_b64?: string;
}

export interface MobileApiPage {
  total: number;
  page: number;
  total_pages: number;
  has_next: boolean;
  devices: MobileApiDevice[];
}
export interface MobileApiImage {
  image_url?: string;
  image_b64?: string;
  caption?: string;
  is_official?: boolean;
  order?: number;
}

export class MobileApiClient {
  private lastRequestAt = 0;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.DEVICE_CATALOG_BASE_URL ||
      DEFAULT_BASE_URL,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const minimumInterval = Number(
      process.env.DEVICE_CATALOG_MIN_REQUEST_INTERVAL_MS || 12000,
    );
    const waitFor = Math.max(
      0,
      minimumInterval - (Date.now() - this.lastRequestAt),
    );
    if (waitFor) await new Promise((resolve) => setTimeout(resolve, waitFor));
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Accept: "application/json",
      },
    });
    this.lastRequestAt = Date.now();
    if (!response.ok)
      throw new Error(
        `Catalog provider returned ${response.status} for ${path}.`,
      );
    return response.json() as Promise<T>;
  }

  // MobileAPI permits up to 50 results in one catalogue request. Use that maximum
  // so a monthly credit buys as much catalogue coverage as possible.
  listDevices(page: number, limit = 50) {
    return this.get<MobileApiPage>(`/devices/?page=${page}&limit=${limit}`);
  }
  listDevicesByManufacturer(manufacturer: string, page: number, limit = 50) {
    return this.get<MobileApiPage>(
      `/devices/by-manufacturer/?manufacturer=${encodeURIComponent(manufacturer)}&page=${page}&limit=${limit}`,
    );
  }
  getImages(deviceId: number) {
    return this.get<MobileApiImage[]>(`/devices/${deviceId}/images/`);
  }
}

export function providerBrand(device: MobileApiDevice): string {
  if (typeof device.brand === "string") return device.brand.trim();
  if (typeof device.manufacturer === "string")
    return device.manufacturer.trim();
  return (
    device.brand?.name ||
    device.manufacturer?.name ||
    device.manufacturer_name ||
    device.brand_name ||
    "Unknown"
  ).trim();
}

export function aliasesFor(device: MobileApiDevice): string[] {
  const modelNumbers = (device.model_numbers || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([device.name, ...modelNumbers])];
}
