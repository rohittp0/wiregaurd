# WireGuard

A GitHub Action that brings up WireGuard tunnels on Ubuntu runners with dynamic domain-based routing and split tunneling support.

## Features

- 🌐 **Dynamic domain routing** - Add routes for domains discovered during workflow execution
- 🎯 **Split tunneling** - Route only specific domains/IPs through the VPN
- 📍 **Direct IP routing** - Support for both IPv4 and IPv6 addresses

## Inputs

| Input     | Required | Default | Description                                                                    |
|-----------|----------|---------|--------------------------------------------------------------------------------|
| `config`  | ✅ Yes    | -       | Base64-encoded `wg-quick` configuration file                                   |
| `domains` | No       | `""`    | Comma-separated list of domains to route through WireGuard                     |
| `ips`     | No       | `""`    | Comma-separated list of IP addresses (IPv4 or IPv6) to route through WireGuard |

## Usage Examples

### 1. Basic Setup (Route All Traffic)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}
```

### 2. Split Tunneling (Specific Domains)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}
          domains: 'api.internal.company.com,database.service.io'
```

### 3. Dynamic Domain Addition (The Power Use Case!)

This is the primary use case - add routes for domains discovered during workflow execution:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # Initial WireGuard setup
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}

      # Query internal VPN-only server to get dynamic domain
      - name: Get dynamic endpoint
        id: endpoint
        run: |
          DOMAIN=$(curl http://internal-vpn-only-server.local/api/get-endpoint)
          echo "domain=$DOMAIN" >> $GITHUB_OUTPUT

      # Dynamically add route for the discovered domain
      - uses: rohittp0/wiregaurd@v2
        with:
          domains: ${{ steps.endpoint.outputs.domain }}

      # Now you can access the dynamic domain
      - name: Deploy to dynamic endpoint
        run: curl https://${{ steps.endpoint.outputs.domain }}/deploy
```

**How it works:**
- First call: Sets up WireGuard interface (detected automatically)
- Second call: Detects interface exists, only adds routes for new domain

### 4. Direct IP Routing

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}
          ips: '10.0.1.50,10.0.2.100,2001:db8::1'
```

### 5. Combined Domains and IPs

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}
          domains: 'api.internal.com,db.internal.com'
          ips: '192.168.1.100,10.0.0.50'
```

### 6. Multiple Dynamic Route Additions

You can call the action multiple times to add routes as needed:

```yaml
jobs:
  multi-service-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: rohittp0/wiregaurd@v2
        with:
          config: ${{ secrets.WG_CLIENT_CONF_BASE64 }}

      - name: Add route for service A
        uses: rohittp0/wiregaurd@v2
        with:
          domains: 'service-a.internal.local'

      - name: Deploy to service A
        run: ./deploy-service-a.sh

      - name: Add route for service B
        uses: rohittp0/wiregaurd@v2
        with:
          domains: 'service-b.internal.local'

      - name: Deploy to service B
        run: ./deploy-service-b.sh
```

## Configuration Guide

### Generating WG_CLIENT_CONF_BASE64

Encode your WireGuard configuration file:

```bash
base64 -w0 wg0.conf > wg0.conf.b64
```

Then add the contents to your GitHub repository or organization secrets as `WG_CLIENT_CONF_BASE64`.

## How It Works

### Automatic Mode Detection

The action automatically determines what to do based on whether the WireGuard interface already exists:

1. **Setup Mode** (first invocation):
   - Installs WireGuard
   - Configures the interface
   - Brings up the tunnel
   - Adds routes for specified domains/IPs

2. **Add-Route Mode** (subsequent invocations):
   - Detects existing interface
   - Resolves domains to IPs (both IPv4 and IPv6)
   - Adds specific routes for each IP
   - No reinstallation or reconfiguration

### DNS Resolution

- Domains are resolved to both IPv4 and IPv6 addresses
- Routes are added for all resolved IPs
- Failed resolutions log warnings but don't fail the workflow
- Route additions are idempotent (adding the same route twice is safe)

### Route Management

Routes are added with `/32` (IPv4) or `/128` (IPv6) prefix lengths, ensuring only traffic to those specific IPs goes through the tunnel.

## Design Decisions

### Why No Cleanup?

This action doesn't include cleanup functionality because:
- GitHub-hosted runners are ephemeral and destroyed after each job
- The entire VM/container is wiped, including all network configurations
- Cleanup would add complexity without benefit for the primary use case

**Note for self-hosted runners:** If you're using self-hosted runners, be aware that routes will persist between jobs. You may want to manually clean up or restart the runner between jobs.

## Troubleshooting

### Routes not working?

- Verify your WireGuard config doesn't use `AllowedIPs = 0.0.0.0/0`
- Check that domains resolve correctly (DNS issues)
- Ensure the WireGuard peer accepts traffic for the routed IPs

### "Interface exists but no domains or IPs specified"

This warning appears when you call the action a second time without providing `domains` or `ips`. It's harmless but indicates nothing was done.

### DNS resolution failures

Some domains may not have IPv4 or IPv6 records. The action logs warnings but continues. Check the logs for details.

## Contributing

Issues and pull requests are welcome! Please report bugs or suggest features at [GitHub Issues](https://github.com/rohittp0/wiregaurd/issues).
