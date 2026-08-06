import type { CountryConfig, GeoTile } from "../types.js";

function tile(
  id: string,
  code: string,
  name: string,
  queryLocation: string,
  lat: number,
  lng: number,
  zoom = 11,
): GeoTile {
  return { id, code, name, queryLocation, lat, lng, zoom };
}

/**
 * US geo tiles. Each state has a centroid tile; CA and NY include denser metro
 * tiles so a pilot can clear ~500 places without hitting Maps' soft result cap.
 */
const tiles: GeoTile[] = [
  // --- California metros (pilot) ---
  tile("CA-sf", "CA", "San Francisco Bay Area", "San Francisco, CA", 37.7749, -122.4194, 11),
  tile("CA-la", "CA", "Los Angeles", "Los Angeles, CA", 34.0522, -118.2437, 11),
  tile("CA-sd", "CA", "San Diego", "San Diego, CA", 32.7157, -117.1611, 11),
  tile("CA-sac", "CA", "Sacramento", "Sacramento, CA", 38.5816, -121.4944, 11),
  tile("CA-sj", "CA", "San Jose", "San Jose, CA", 37.3382, -121.8863, 11),
  tile("CA-oak", "CA", "Oakland", "Oakland, CA", 37.8044, -122.2712, 12),
  tile("CA-oc", "CA", "Orange County", "Irvine, CA", 33.6846, -117.8265, 11),
  tile("CA-fresno", "CA", "Fresno", "Fresno, CA", 36.7378, -119.7871, 11),

  // --- New York metros (pilot) ---
  tile("NY-nyc", "NY", "New York City", "New York, NY", 40.7128, -74.006, 12),
  tile("NY-brooklyn", "NY", "Brooklyn", "Brooklyn, NY", 40.6782, -73.9442, 13),
  tile("NY-queens", "NY", "Queens", "Queens, NY", 40.7282, -73.7949, 12),
  tile("NY-albany", "NY", "Albany", "Albany, NY", 42.6526, -73.7562, 11),
  tile("NY-buffalo", "NY", "Buffalo", "Buffalo, NY", 42.8864, -78.8784, 11),
  tile("NY-rochester", "NY", "Rochester", "Rochester, NY", 43.1566, -77.6088, 11),
  tile("NY-syracuse", "NY", "Syracuse", "Syracuse, NY", 43.0481, -76.1474, 11),
  tile("NY-longisland", "NY", "Long Island", "Hempstead, NY", 40.7062, -73.6187, 11),

  // --- Remaining US states (single centroid tiles) ---
  tile("AL", "AL", "Alabama", "Alabama, USA", 32.8067, -86.7911, 8),
  tile("AK", "AK", "Alaska", "Alaska, USA", 61.3707, -152.4044, 5),
  tile("AZ", "AZ", "Arizona", "Arizona, USA", 33.7298, -111.4312, 7),
  tile("AR", "AR", "Arkansas", "Arkansas, USA", 34.9697, -92.3731, 8),
  tile("CO", "CO", "Colorado", "Colorado, USA", 39.0598, -105.3111, 7),
  tile("CT", "CT", "Connecticut", "Connecticut, USA", 41.5978, -72.7554, 9),
  tile("DE", "DE", "Delaware", "Delaware, USA", 39.3185, -75.5071, 9),
  tile("FL", "FL", "Florida", "Florida, USA", 27.7663, -81.6868, 7),
  tile("GA", "GA", "Georgia", "Georgia, USA", 33.0406, -83.6431, 7),
  tile("HI", "HI", "Hawaii", "Hawaii, USA", 21.0943, -157.4983, 8),
  tile("ID", "ID", "Idaho", "Idaho, USA", 44.2405, -114.4788, 7),
  tile("IL", "IL", "Illinois", "Illinois, USA", 40.3495, -88.9861, 7),
  tile("IN", "IN", "Indiana", "Indiana, USA", 39.8494, -86.2583, 8),
  tile("IA", "IA", "Iowa", "Iowa, USA", 42.0115, -93.2105, 7),
  tile("KS", "KS", "Kansas", "Kansas, USA", 38.5266, -96.7265, 7),
  tile("KY", "KY", "Kentucky", "Kentucky, USA", 37.6681, -84.6701, 8),
  tile("LA", "LA", "Louisiana", "Louisiana, USA", 31.1695, -91.8678, 8),
  tile("ME", "ME", "Maine", "Maine, USA", 44.6939, -69.3819, 7),
  tile("MD", "MD", "Maryland", "Maryland, USA", 39.0639, -76.8021, 9),
  tile("MA", "MA", "Massachusetts", "Massachusetts, USA", 42.2302, -71.5301, 9),
  tile("MI", "MI", "Michigan", "Michigan, USA", 43.3266, -84.5361, 7),
  tile("MN", "MN", "Minnesota", "Minnesota, USA", 45.6945, -93.9002, 7),
  tile("MS", "MS", "Mississippi", "Mississippi, USA", 32.7416, -89.6787, 8),
  tile("MO", "MO", "Missouri", "Missouri, USA", 38.4561, -92.2884, 7),
  tile("MT", "MT", "Montana", "Montana, USA", 46.9219, -110.4544, 6),
  tile("NE", "NE", "Nebraska", "Nebraska, USA", 41.1254, -98.2681, 7),
  tile("NV", "NV", "Nevada", "Nevada, USA", 38.3135, -117.0554, 6),
  tile("NH", "NH", "New Hampshire", "New Hampshire, USA", 43.4525, -71.5639, 8),
  tile("NJ", "NJ", "New Jersey", "New Jersey, USA", 40.2989, -74.521, 9),
  tile("NM", "NM", "New Mexico", "New Mexico, USA", 34.8405, -106.2485, 7),
  tile("NC", "NC", "North Carolina", "North Carolina, USA", 35.6301, -79.8064, 7),
  tile("ND", "ND", "North Dakota", "North Dakota, USA", 47.5289, -99.784, 7),
  tile("OH", "OH", "Ohio", "Ohio, USA", 40.3888, -82.7649, 8),
  tile("OK", "OK", "Oklahoma", "Oklahoma, USA", 35.5653, -96.9289, 7),
  tile("OR", "OR", "Oregon", "Oregon, USA", 44.572, -122.0709, 7),
  tile("PA", "PA", "Pennsylvania", "Pennsylvania, USA", 40.5908, -77.2098, 8),
  tile("RI", "RI", "Rhode Island", "Rhode Island, USA", 41.6809, -71.5118, 10),
  tile("SC", "SC", "South Carolina", "South Carolina, USA", 33.8569, -80.945, 8),
  tile("SD", "SD", "South Dakota", "South Dakota, USA", 44.2998, -99.4388, 7),
  tile("TN", "TN", "Tennessee", "Tennessee, USA", 35.7478, -86.6923, 8),
  tile("TX", "TX", "Texas", "Texas, USA", 31.0545, -97.5635, 6),
  tile("UT", "UT", "Utah", "Utah, USA", 40.150, -111.8624, 7),
  tile("VT", "VT", "Vermont", "Vermont, USA", 44.0459, -72.7107, 8),
  tile("VA", "VA", "Virginia", "Virginia, USA", 37.7693, -78.17, 8),
  tile("WA", "WA", "Washington", "Washington, USA", 47.4009, -121.4905, 7),
  tile("WV", "WV", "West Virginia", "West Virginia, USA", 38.4912, -80.9545, 8),
  tile("WI", "WI", "Wisconsin", "Wisconsin, USA", 44.2685, -89.6165, 7),
  tile("WY", "WY", "Wyoming", "Wyoming, USA", 42.7555, -107.3025, 7),
  tile("DC", "DC", "Washington DC", "Washington, DC", 38.9072, -77.0369, 12),
];

export const usCountry: CountryConfig = {
  country: "us",
  countryName: "United States",
  tiles,
};
