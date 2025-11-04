import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import {promises as fs} from "fs";
import * as os from "os";
import * as path from "path";
import {promises as dns} from "dns";

async function checkInterfaceExists(iface: string): Promise<boolean> {
    const result = await exec.getExecOutput("ip", ["link", "show", iface], {ignoreReturnCode: true, silent: true});
    return result.exitCode === 0;
}

async function installWireGuard(): Promise<void> {
    core.info("Installing WireGuard...");
    await exec.exec("sudo", ["apt-get", "update"]);
    await exec.exec("sudo", ["apt-get", "install", "-y", "wireguard"]);
}

async function setupWireGuardConfig(config: string, iface: string): Promise<void> {
    const decoded = Buffer.from(config, "base64").toString("utf8");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wg-"));
    const tmpConf = path.join(tmpDir, `${iface}.conf`);
    await fs.writeFile(tmpConf, decoded, {mode: 0o600});

    const etcDir = "/etc/wireguard";
    await io.mkdirP(etcDir);
    const etcConf = path.join(etcDir, `${iface}.conf`);
    await exec.exec("sudo", ["cp", tmpConf, etcConf]);
    await exec.exec("sudo", ["chmod", "600", etcConf]);
}

async function startWireGuard(iface: string): Promise<void> {
    core.info(`Starting WireGuard interface '${iface}'...`);
    await exec.exec("sudo", ["wg-quick", "up", iface]);
    core.info(`WireGuard interface '${iface}' is up.`);
    await new Promise((r) => setTimeout(r, 4000));
}

async function addSingleRoute(ip: string, iface: string): Promise<void> {
    const isIPv6 = ip.includes(":");
    const cidr = isIPv6 ? `${ip}/128` : `${ip}/32`;
    const args = isIPv6 ? ["-6", "route", "add", cidr, "dev", iface] : ["route", "add", cidr, "dev", iface];
    await exec.exec("sudo", ["ip", ...args], {ignoreReturnCode: true});
}

async function resolveDomainIPs(domain: string): Promise<string[]> {
    const resolved: string[] = [];
    try {
        const v4 = await dns.resolve4(domain);
        resolved.push(...v4);
    } catch (e: any) {
        core.warning(`IPv4 resolution failed for ${domain}: ${e.message}`);
    }
    try {
        const v6 = await dns.resolve6(domain);
        resolved.push(...v6);
    } catch (e: any) {
        core.warning(`IPv6 resolution failed for ${domain}: ${e.message}`);
    }
    return resolved;
}

async function addRoutesForDomains(domains: string[], iface: string): Promise<string[]> {
    const allIPs: string[] = [];
    for (const domain of domains) {
        core.info(`Resolving ${domain}...`);
        const ips = await resolveDomainIPs(domain);
        for (const ip of ips) {
            try {
                core.info(`Adding route for ${domain} (${ip}) via ${iface}`);
                await addSingleRoute(ip, iface);
                allIPs.push(ip);
            } catch (err: any) {
                core.warning(`Failed to add route for ${ip}: ${err.message}`);
            }
        }
    }
    return allIPs;
}

async function addRoutesForIPs(ips: string[], iface: string): Promise<void> {
    for (const ip of ips) {
        try {
            await addSingleRoute(ip, iface);
            core.info(`Added route for ${ip}`);
        } catch (err: any) {
            core.warning(`Failed to add route for ${ip}: ${err.message}`);
        }
    }
}

async function addRoutes(domains: string[], ips: string[], iface: string): Promise<string[]> {
    const domainIPs = await addRoutesForDomains(domains, iface);
    await addRoutesForIPs(ips, iface);
    return [...domainIPs, ...ips];
}

async function getPublicIP(): Promise<string | null> {
    let output = "";
    const opts = {listeners: {stdout: (data: Buffer) => (output += data.toString())}, silent: true};
    await exec.exec("bash", ["-lc", "curl -fsSL https://ifconfig.me || true"], opts);
    return output.trim() || null;
}

async function run() {
    try {
        if (process.platform !== "linux") {
            core.setFailed("This action supports only Linux runners.");
            return;
        }

        const iface = core.getInput("iface") || "wg0";
        const domains = (core.getInput("domains") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        const ips = (core.getInput("ips") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);

        const ifaceExists = await checkInterfaceExists(iface);

        if (!ifaceExists) {
            const config = core.getInput("config", {required: true});
            await installWireGuard();
            await setupWireGuardConfig(config, iface);
            await startWireGuard(iface);
        } else {
            core.info(`Interface ${iface} already exists, skipping setup.`);
        }

        if (domains.length || ips.length) {
            core.info("Adding dynamic routes...");
            const allIPs = await addRoutes(domains, ips, iface);
            core.info(`Added ${allIPs.length} route(s).`);
        } else {
            core.info("No domains or IPs provided, routing all traffic through WireGuard.");
        }

        const pubIP = await getPublicIP();
        if (pubIP) {
            core.setOutput("public_ip", pubIP);
            core.info(`Public IP via WG: ${pubIP}`);
        }
    } catch (err: any) {
        core.setFailed(`WireGuard action failed: ${err?.message || err}`);
    }
}

run().then();
