import { isIP } from "node:net";

// Never trust arbitrary forwarded headers or a hop count on variable-length
// proxy paths. Operators must name the actual reverse-proxy IPs/subnets.
export function trustedProxyNetworks(raw = "") {
  if (!raw.trim()) return false;
  return raw.split(",").map(value => {
    const entry = value.trim();
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined && (
      !/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)
    ))) throw new Error("TRUSTED_PROXY_CIDRS must contain explicit proxy IPs or non-global CIDRs, never wildcards or hop counts.");
    return entry;
  });
}
