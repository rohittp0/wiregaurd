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

async function addSingleRoute(ip: string, iface: string): Promise<void> {
    const isIpv6 = ip.includes(":");
    const cidr = isIpv6 ? `${ip}/128` : `${ip}/32`;
    const ipCommand = isIpv6 ? ["ip", "-6"] : ["ip"];

    await exec.exec("sudo", [...ipCommand, "route", "add", cidr, "dev", iface]);
}

async function resolveDomainIPs(domain: string): Promise<string[]> {
    const ips: string[] = [];

    // Helper to add timeout to DNS resolution
    const resolveWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
        const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), timeoutMs)
        );
        return Promise.race([promise, timeoutPromise]);
    };

    // Resolve IPv4 with timeout
    try {
        const ipv4Addresses = await resolveWithTimeout(dns.resolve4(domain), 5000);
        if (ipv4Addresses) {
            ips.push(...ipv4Addresses);
        } else {
            core.warning(`IPv4 resolution for ${domain} timed out`);
        }
    } catch (err: any) {
        if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') {
            core.warning(`Failed to resolve IPv4 for ${domain}: ${err.message}`);
        }
    }

    // Resolve IPv6 with timeout
    try {
        const ipv6Addresses = await resolveWithTimeout(dns.resolve6(domain), 5000);
        if (ipv6Addresses) {
            ips.push(...ipv6Addresses);
        } else {
            core.warning(`IPv6 resolution for ${domain} timed out`);
        }
    } catch (err: any) {
        if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') {
            core.warning(`Failed to resolve IPv6 for ${domain}: ${err.message}`);
        }
    }

    return ips;
}

async function addRoutesForDomains(domains: string[], iface: string): Promise<string[]> {
    if (!domains.length) return [];

    core.info(`Adding routes for ${domains.length} domain(s)...`);
    let routeCount = 0;
    const allIPs: string[] = [];

    for (const domain of domains) {
        core.info(`Resolving ${domain}...`);
        const ips = await resolveDomainIPs(domain);

        for (const ip of ips) {
            try {
                core.info(`Adding route for ${domain} (${ip}) via ${iface}`);
                await addSingleRoute(ip, iface);
                routeCount++;
                allIPs.push(ip);
            } catch (err: any) {
                core.warning(`Failed to add route for ${ip}: ${err.message}`);
            }
        }
    }

    core.info(`Added ${routeCount} route(s) for domains.`);
    return allIPs;
}

async function addRoutesForIPs(ips: string[], iface: string): Promise<void> {
    if (!ips.length) return;

    core.info(`Adding routes for ${ips.length} IP address(es)...`);
    let routeCount = 0;

    for (const ip of ips) {
        try {
            const cidr = ip.includes(":") ? `${ip}/128` : `${ip}/32`;
            core.info(`Adding route for ${cidr} via ${iface}`);
            await addSingleRoute(ip, iface);
            routeCount++;
        } catch (err: any) {
            core.warning(`Failed to add route for ${ip}: ${err.message}`);
        }
    }

    core.info(`Added ${routeCount} route(s) for IPs.`);

}

async function testConnectivity(ips: string[]): Promise<void> {
    if (!ips.length) return;

    core.info("Testing connectivity to routed IPs...");

    for (const ip of ips.slice(0, 3)) { // Test up to 3 IPs to avoid timeout
        try {
            core.info(`Pinging ${ip}...`);
            const pingCmd = ip.includes(":") ? "ping6" : "ping";

            // Use a promise race to implement hard timeout
            const pingPromise = exec.exec(pingCmd, ["-c", "2", "-W", "3", ip], {ignoreReturnCode: true});
            const timeoutPromise = new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("Ping timeout")), 10000)
            );

            await Promise.race([pingPromise, timeoutPromise]);
        } catch (err: any) {
            core.warning(`Ping test for ${ip} failed or timed out: ${err.message}`);
        }
    }
}

async function addRoutes(domains: string[], ips: string[], iface: string): Promise<string[]> {
    const domainIPs = await addRoutesForDomains(domains, iface);
    await addRoutesForIPs(ips, iface);
    return [...domainIPs, ...ips];
}

async function installWireGuard(): Promise<void> {
    core.info("Installing WireGuard...");
    await exec.exec("sudo", ["apt-get", "install", "-y", "wireguard"]);
}

async function setupWireGuardConfig(config: string, iface: string, stripDns: boolean): Promise<void> {
    // Decode config
    let configContent = Buffer.from(config, "base64").toString("utf8");

    // Strip DNS if requested
    if (stripDns) {
        core.info("Stripping DNS configuration to preserve system DNS...");
        configContent = configContent
            .split("\n")
            .filter(line => !line.trim().toLowerCase().startsWith("dns"))
            .join("\n");
    }

    // Write to temp file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wg-"));
    const tmpConf = path.join(tmpDir, `${iface}.conf`);
    await fs.writeFile(tmpConf, configContent, {mode: 0o600});

    // Copy to /etc/wireguard with proper permissions
    const etcDir = "/etc/wireguard";
    await io.mkdirP(etcDir);
    const etcConf = path.join(etcDir, `${iface}.conf`);
    await exec.exec("sudo", ["cp", tmpConf, etcConf]);
    await exec.exec("sudo", ["chmod", "600", etcConf]);
}

async function startWireGuardInterface(iface: string): Promise<void> {
    core.info(`Starting WireGuard interface '${iface}'...`);
    await exec.exec("sudo", ["wg-quick", "up", iface]);
    core.info(`WireGuard interface '${iface}' is up.`);

    // Wait for interface to stabilize
    core.info("Waiting for tunnel to stabilize...");
    await new Promise(resolve => setTimeout(resolve, 5000));
}

async function setupWireGuard(config: string, iface: string, stripDns: boolean): Promise<void> {
    await installWireGuard();
    await setupWireGuardConfig(config, iface, stripDns);
    await startWireGuardInterface(iface);
}

async function handleAddRouteMode(domains: string[], ips: string[], iface: string): Promise<void> {
    core.info(`WireGuard interface '${iface}' already exists. Adding routes...`);

    if (!domains.length && !ips.length) {
        core.warning("Interface exists but no domains or IPs specified. Nothing to do.");
        return;
    }

    const allIPs = await addRoutes(domains, ips, iface);

    // Test connectivity
    if (allIPs.length > 0) {
        await testConnectivity(allIPs);
    }

    core.info("Route addition complete.");
}

async function handleSetupMode(config: string, domains: string[], ips: string[], iface: string, stripDns: boolean): Promise<void> {
    core.info("Setting up WireGuard interface...");

    await setupWireGuard(config, iface, stripDns);
    const allIPs = await addRoutes(domains, ips, iface);

    // Test connectivity
    if (allIPs.length > 0) {
        await testConnectivity(allIPs);
    }

    core.info("WireGuard setup complete.");
}

function parseInputList(input: string): string[] {
    return input.split(",").map(item => item.trim()).filter(item => item);
}

async function run() {
    try {
        if (process.platform !== "linux") {
            core.setFailed("This action currently supports only Linux runners.");
            return;
        }

        // Parse inputs
        const iface = core.getInput("iface") || "wg0";
        const domains = parseInputList(core.getInput("domains") || "");
        const ips = parseInputList(core.getInput("ips") || "");
        const stripDns = core.getInput("strip_dns") !== "false"; // Default true

        // Determine mode based on interface existence
        const interfaceExists = await checkInterfaceExists(iface);

        if (interfaceExists) {
            await handleAddRouteMode(domains, ips, iface);
        } else {
            const config = core.getInput("config", {required: true});
            await handleSetupMode(config, domains, ips, iface, stripDns);
        }
    } catch (err: any) {
        core.setFailed(`WireGuard action failed: ${err?.message || err}`);
    }
}

run().then();
