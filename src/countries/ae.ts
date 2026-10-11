import type { CountryConfig, GeoTile } from "../types.js";

function tile(
  id: string,
  code: string,
  name: string,
  queryLocation: string,
  lat: number,
  lng: number,
  zoom = 12,
): GeoTile {
  return { id, code, name, queryLocation, lat, lng, zoom };
}

/**
 * UAE geo tiles. Dubai and Abu Dhabi use denser metro tiles for finance hubs
 * (DIFC, ADGM, Marina, Business Bay). Remaining emirates use centroid tiles.
 */
const tiles: GeoTile[] = [
  // --- Dubai metros (finance / business dense) ---
  tile("DXB-difc", "DXB", "DIFC", "DIFC, Dubai, UAE", 25.2111, 55.2789, 15),
  tile("DXB-downtown", "DXB", "Downtown Dubai", "Downtown Dubai, UAE", 25.1972, 55.2744, 14),
  tile("DXB-marina", "DXB", "Dubai Marina", "Dubai Marina, UAE", 25.0805, 55.1403, 14),
  tile("DXB-businessbay", "DXB", "Business Bay", "Business Bay, Dubai, UAE", 25.1851, 55.2725, 14),
  tile("DXB-jlt", "DXB", "Jumeirah Lake Towers", "JLT, Dubai, UAE", 25.0693, 55.1413, 14),
  tile("DXB-deira", "DXB", "Deira", "Deira, Dubai, UAE", 25.2697, 55.3095, 13),
  tile("DXB-barsha", "DXB", "Al Barsha", "Al Barsha, Dubai, UAE", 25.1111, 55.1986, 13),
  tile("DXB-city", "DXB", "Dubai", "Dubai, UAE", 25.2048, 55.2708, 11),

  // --- Abu Dhabi metros ---
  tile("AUH-adgm", "AUH", "ADGM / Al Maryah", "Al Maryah Island, Abu Dhabi, UAE", 24.5011, 54.3885, 15),
  tile("AUH-corniche", "AUH", "Abu Dhabi Corniche", "Corniche, Abu Dhabi, UAE", 24.4764, 54.3418, 13),
  tile("AUH-khalifa", "AUH", "Khalifa City", "Khalifa City, Abu Dhabi, UAE", 24.4197, 54.5805, 12),
  tile("AUH-city", "AUH", "Abu Dhabi", "Abu Dhabi, UAE", 24.4539, 54.3773, 11),

  // --- Remaining emirates ---
  tile("SHJ", "SHJ", "Sharjah", "Sharjah, UAE", 25.3463, 55.4209, 11),
  tile("AJM", "AJM", "Ajman", "Ajman, UAE", 25.4052, 55.5136, 12),
  tile("RAK", "RAK", "Ras Al Khaimah", "Ras Al Khaimah, UAE", 25.7895, 55.9432, 11),
  tile("FUJ", "FUJ", "Fujairah", "Fujairah, UAE", 25.1288, 56.3265, 11),
  tile("UAQ", "UAQ", "Umm Al Quwain", "Umm Al Quwain, UAE", 25.5647, 55.5552, 12),
];

export const aeCountry: CountryConfig = {
  country: "ae",
  countryName: "United Arab Emirates",
  tiles,
};
