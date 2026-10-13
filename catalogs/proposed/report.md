# Crawl report

- Started: 2026-10-13T01:59:25.857Z
- Finished: 2026-10-13T01:59:25.880Z (0s)
- Arguments: `{"adapters":["driver-listings"],"allow-aggregators":true,"use-fixtures":true}`

> Everything listed here is a proposal. Nothing is verified, nothing was downloaded or executed, and no binary was mirrored.

## Adapter `driver-listings`

- Source: driver-listings
- Targets: 1 · proposed: 34 · unchanged: 0 · failed: 1
- HTTP: 0 requests, 0 cache hits, 0 not-modified, 0 retries, 0 blocked

| Quality flag | Records |
| --- | ---: |
| architecture_not_stated | 9 |
| date_inconsistent | 1 |
| download_gated_by_verification_code | 34 |
| download_path_robots_disallowed | 34 |
| filename_vendor_mismatch | 1 |
| filename_version_mismatch | 6 |
| legacy_os_only | 9 |
| lists_end_of_support_os | 34 |
| multi_device_row | 1 |
| non_english_name | 6 |
| vendor_device_mismatch | 7 |

### Errors

| Target | Code | Message |
| --- | --- | --- |
| `pci-standard-pci-to-pci-bridge-1-3-4-61-6a6b29` | NO_OFFICIAL_MAPPING | No official vendor portal in vendors.json for "Matrox Graphics"; a lead without an official source is not proposed. |

