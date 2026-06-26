#!/bin/bash
# browser-manager deployment script
#
# DEPLOY: Push main to prod — GitHub Actions runs this script automatically:
#   git push origin main:prod
#
# Manual commands:
#   ./deploy.sh              Deploy to production
#   ./deploy.sh rollback     Rollback to previous release
#   ./deploy.sh status       Check status
#   ./deploy.sh logs         View logs
#   ./deploy.sh releases     List releases
#   ./deploy.sh setup        First-time server setup (installs PM2, .env)

set -e

source "$(dirname "$0")/scripts/deploy-lib.sh"

# Coexists with `browsing` on the same host (which owns browser.todofor.ai
# + ports 8085/8086 — unrelated legacy service).
# browser-manager runs on bm.todofor.ai with blue/green slots:
#   Slot A: REST 8600 / Admin 8610 / CDP 8620 / Noise 8630
#   Slot B: REST 8602 / Admin 8612 / CDP 8622 / Noise 8632
SERVER="${SERVER:-root@browser.todofor.ai}"
DEPLOY_PATH="/var/www/todoforai/apps/browser-manager"
REPO="git@github.com:todoforai/browser-manager.git"
BRANCH="prod"
KEEP_RELEASES=5

# Blue/green REST ports. Noise port = REST + 30; CDP port = REST + 20.
PORT_A=8600
PORT_B=8602

deploy() {
    check_prod_status
    log "Starting browser-manager deployment to $SERVER..."

    RELEASE=$(date +%Y%m%d%H%M%S)

    ssh $SERVER 'bash -s' << EOF
        set -e

        mkdir -p $DEPLOY_PATH/releases $DEPLOY_PATH/shared

        echo "Creating release $RELEASE..."
        git clone --depth 1 --branch $BRANCH $REPO $DEPLOY_PATH/releases/$RELEASE

        $(declare -f sync_repo)

        echo "Setting up noise-ts (sibling of release; resolves file:../noise-ts)..."
        sync_repo $DEPLOY_PATH/releases/noise-ts git@github.com:todoforai/noise-ts.git main
        cd $DEPLOY_PATH/releases/noise-ts
        ~/.bun/bin/bun install
        ~/.bun/bin/bun run build

        echo "Installing dependencies..."
        cd $DEPLOY_PATH/releases/$RELEASE
        ~/.bun/bin/bun install

        echo "Installing Playwright Chromium system dependencies..."
        # apt/dpkg locks can be held briefly by unattended upgrades or another
        # deploy. Retry instead of failing an otherwise healthy release.
        for i in \$(seq 1 30); do
            if ~/.bun/bin/bun node_modules/playwright/cli.js install-deps chromium; then
                break
            fi
            [ \$i -eq 30 ] && { echo "❌ Playwright dependency install failed after retries"; exit 1; }
            echo "apt/dpkg busy; retrying Playwright deps in 10s (\$i/30)..."
            sleep 10
        done

        echo "Installing Playwright Chromium..."
        ~/.bun/bin/bun node_modules/playwright/cli.js install chromium

        echo "Linking shared dir for ecosystem.config.cjs to read..."
        ln -sfn $DEPLOY_PATH/shared $DEPLOY_PATH/releases/$RELEASE/shared

        echo "Updating current symlink..."
        ln -sfn $DEPLOY_PATH/releases/$RELEASE $DEPLOY_PATH/current

        echo "Rolling deploy..."
        cd $DEPLOY_PATH/current

        # One-shot migration cleanup: remove pre-migration PM2 names from the
        # 8090/8092 era. They no longer match $PORT_A/$PORT_B so the normal
        # detection below would leave them orphaned. Safe to remove on every
        # deploy — does nothing once the units are gone.
        for legacy in browser-manager-8090 browser-manager-8092; do
            if pm2 list 2>/dev/null | grep -q "\$legacy"; then
                echo "Stopping legacy PM2 process: \$legacy"
                pm2 delete "\$legacy" 2>/dev/null || true
            fi
        done
        pm2 save --force

        # Determine which port is currently active under PM2
        OLD_PORT=""
        NEW_PORT=""
        if pm2 list 2>/dev/null | grep -q "browser-manager-$PORT_A"; then
            OLD_PORT=$PORT_A; NEW_PORT=$PORT_B
        elif pm2 list 2>/dev/null | grep -q "browser-manager-$PORT_B"; then
            OLD_PORT=$PORT_B; NEW_PORT=$PORT_A
        else
            NEW_PORT=$PORT_A
        fi

        NGINX_CONF=/etc/nginx/sites-available/bm.todofor.ai
        STREAM_CONF=/etc/nginx/streams-available/bm-noise-stream.conf

        # NODE_ENV must be in the shell env (not just --env production) because
        # ecosystem.config.cjs reads process.env.NODE_ENV at load time to decide
        # whether to include the dev-only web sidecar. --env production only
        # selects env_production overrides after the config is evaluated.
        echo "Starting new instance on port \$NEW_PORT..."
        NODE_ENV=production DEPLOY_PORT=\$NEW_PORT pm2 start ecosystem.config.cjs --env production
        pm2 save --force

        # Wait for new instance to be healthy before touching nginx
        echo "Waiting for new instance..."
        for i in \$(seq 1 30); do
            if curl -sf http://127.0.0.1:\$NEW_PORT/health >/dev/null 2>&1; then
                echo "✅ New instance healthy on port \$NEW_PORT"
                break
            fi
            [ \$i -eq 30 ] && { echo "❌ New instance failed to start!"; pm2 logs browser-manager-\$NEW_PORT --lines 40 --nostream; exit 1; }
            sleep 1
        done

        # Sync nginx site + stream confs from repo
        cp $DEPLOY_PATH/current/nginx/bm.todofor.ai.conf \$NGINX_CONF
        ln -sf \$NGINX_CONF /etc/nginx/sites-enabled/bm.todofor.ai

        mkdir -p /etc/nginx/streams-available /etc/nginx/streams-enabled
        cp $DEPLOY_PATH/current/nginx/noise-stream.conf \$STREAM_CONF
        ln -sf \$STREAM_CONF /etc/nginx/streams-enabled/bm-noise-stream.conf
        if ! grep -q 'streams-enabled' /etc/nginx/nginx.conf; then
            echo 'stream { include /etc/nginx/streams-enabled/*.conf; }' >> /etc/nginx/nginx.conf
        fi

        # Flip upstreams: mark all down, bring the new one up (REST + CDP slots)
        NEW_CDP=\$((NEW_PORT + 20))
        CDP_A=\$(($PORT_A + 20))
        CDP_B=\$(($PORT_B + 20))
        sed -i "s|server 127.0.0.1:$PORT_A[^;]*;|server 127.0.0.1:$PORT_A down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:$PORT_B[^;]*;|server 127.0.0.1:$PORT_B down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:\$CDP_A[^;]*;|server 127.0.0.1:\$CDP_A down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:\$CDP_B[^;]*;|server 127.0.0.1:\$CDP_B down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:\$NEW_PORT down;|server 127.0.0.1:\$NEW_PORT max_fails=2 fail_timeout=5s;|" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:\$NEW_CDP down;|server 127.0.0.1:\$NEW_CDP max_fails=2 fail_timeout=5s;|" \$NGINX_CONF

        NEW_NOISE=\$((NEW_PORT + 30))
        NOISE_A=\$(($PORT_A + 30))
        NOISE_B=\$(($PORT_B + 30))
        sed -i "s|server 127.0.0.1:\$NOISE_A[^;]*;|server 127.0.0.1:\$NOISE_A down;|g" \$STREAM_CONF
        sed -i "s|server 127.0.0.1:\$NOISE_B[^;]*;|server 127.0.0.1:\$NOISE_B down;|g" \$STREAM_CONF
        sed -i "s|server 127.0.0.1:\$NEW_NOISE down;|server 127.0.0.1:\$NEW_NOISE max_fails=2 fail_timeout=5s;|" \$STREAM_CONF

        nginx -t && systemctl reload nginx

        # Drain old instance (if any) — nginx already switched, safe to stop
        if [ -n "\$OLD_PORT" ]; then
            echo "Draining old instance on port \$OLD_PORT..."
            pm2 stop browser-manager-\$OLD_PORT
            pm2 delete browser-manager-\$OLD_PORT 2>/dev/null || true
            pm2 save --force
            echo "✅ Old instance stopped"
        fi

        sleep 1
        if curl -sf http://127.0.0.1:\$NEW_PORT/health >/dev/null 2>&1; then
            echo "✅ browser-manager healthy on port \$NEW_PORT!"
        else
            echo "❌ Final health check failed!"
            pm2 logs browser-manager-\$NEW_PORT --lines 40 --nostream
            exit 1
        fi

        echo "Cleaning old releases..."
        cd $DEPLOY_PATH/releases && ls -t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

        echo "Done! Deployed: $RELEASE"
EOF

    log "Deployment complete!"
}

rollback() {
    log "Rolling back..."

    ssh $SERVER 'bash -s' -- "$DEPLOY_PATH" "$PORT_A" "$PORT_B" << 'EOF'
        set -e
        DEPLOY_PATH="$1"
        PORT_A="$2"
        PORT_B="$3"
        cd $DEPLOY_PATH/releases

        CURRENT=$(readlink $DEPLOY_PATH/current | xargs basename)
        PREVIOUS=$(ls -t | grep -v "^$CURRENT$" | head -1)
        [ -z "$PREVIOUS" ] && { echo "No previous release found!"; exit 1; }

        echo "Current: $CURRENT → Rolling back to: $PREVIOUS"
        ln -sfn $DEPLOY_PATH/releases/$PREVIOUS $DEPLOY_PATH/current

        # Determine which port is currently live
        LIVE_PORT=""
        pm2 list 2>/dev/null | grep -q "browser-manager-$PORT_A" && LIVE_PORT=$PORT_A
        pm2 list 2>/dev/null | grep -q "browser-manager-$PORT_B" && LIVE_PORT=$PORT_B
        ROLLBACK_PORT=$PORT_A
        [ "$LIVE_PORT" = "$PORT_A" ] && ROLLBACK_PORT=$PORT_B

        # Start rollback on the inactive port first
        cd $DEPLOY_PATH/current
        NODE_ENV=production DEPLOY_PORT=$ROLLBACK_PORT pm2 start ecosystem.config.cjs --env production
        pm2 save --force

        # Wait healthy before touching nginx
        NGINX_CONF=/etc/nginx/sites-available/bm.todofor.ai
        STREAM_CONF=/etc/nginx/streams-available/bm-noise-stream.conf
        # Sync nginx confs from the rollback release so the edge config matches
        # the code being restored. Critical for the /cdp/ auth migration: rolling
        # back to a pre-auth release must also drop its public /cdp/ location.
        cp $DEPLOY_PATH/current/nginx/bm.todofor.ai.conf $NGINX_CONF
        cp $DEPLOY_PATH/current/nginx/noise-stream.conf $STREAM_CONF
        for i in $(seq 1 15); do
            curl -sf http://127.0.0.1:$ROLLBACK_PORT/health >/dev/null 2>&1 && echo "✅ Rollback instance healthy" && break
            [ $i -eq 15 ] && { echo "❌ Rollback health check failed!"; pm2 logs browser-manager-$ROLLBACK_PORT --lines 40 --nostream; pm2 delete browser-manager-$ROLLBACK_PORT 2>/dev/null; exit 1; }
            sleep 2
        done

        ROLLBACK_NOISE=$((ROLLBACK_PORT + 30))
        ROLLBACK_CDP=$((ROLLBACK_PORT + 20))
        CDP_A=$((PORT_A + 20))
        CDP_B=$((PORT_B + 20))
        NOISE_A=$((PORT_A + 30))
        NOISE_B=$((PORT_B + 30))
        sed -i "s|server 127.0.0.1:$PORT_A[^;]*;|server 127.0.0.1:$PORT_A down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:$PORT_B[^;]*;|server 127.0.0.1:$PORT_B down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:$CDP_A[^;]*;|server 127.0.0.1:$CDP_A down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:$CDP_B[^;]*;|server 127.0.0.1:$CDP_B down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:${ROLLBACK_PORT} down;|server 127.0.0.1:${ROLLBACK_PORT} max_fails=2 fail_timeout=5s;|" $NGINX_CONF
        sed -i "s|server 127.0.0.1:${ROLLBACK_CDP} down;|server 127.0.0.1:${ROLLBACK_CDP} max_fails=2 fail_timeout=5s;|" $NGINX_CONF

        sed -i "s|server 127.0.0.1:$NOISE_A[^;]*;|server 127.0.0.1:$NOISE_A down;|g" $STREAM_CONF
        sed -i "s|server 127.0.0.1:$NOISE_B[^;]*;|server 127.0.0.1:$NOISE_B down;|g" $STREAM_CONF
        sed -i "s|server 127.0.0.1:${ROLLBACK_NOISE} down;|server 127.0.0.1:${ROLLBACK_NOISE} max_fails=2 fail_timeout=5s;|" $STREAM_CONF

        nginx -t && systemctl reload nginx

        if [ -n "$LIVE_PORT" ]; then
            pm2 delete browser-manager-$LIVE_PORT 2>/dev/null || true
            pm2 save --force
        fi

        echo "Rolled back to $PREVIOUS"
EOF

    log "Rollback complete!"
}

status()   { pm2_status 'browser-manager-*' "$DEPLOY_PATH"; }
logs()     { pm2_app_logs 'browser-manager-*'; }
releases() { list_releases "$DEPLOY_PATH"; }

setup() {
    log "Setting up server..."
    ssh $SERVER << 'EOF'
        set -e
        mkdir -p /var/www/todoforai/apps/browser-manager/{releases,shared}
        mkdir -p /var/log/todoforai
        SHARED=/var/www/todoforai/apps/browser-manager/shared

        # Install Node + PM2 + Bun if missing
        if ! command -v pm2 >/dev/null 2>&1; then
            echo "Installing Node.js + PM2..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
            npm install -g pm2
            pm2 startup systemd -u root --hp /root
        fi

        if ! [ -x ~/.bun/bin/bun ]; then
            echo "Installing Bun..."
            curl -fsSL https://bun.sh/install | bash
        fi

        # Chromium system deps (libnspr4, libnss3, fonts, …) are installed by
        # `playwright install-deps chromium` during deploy(), using the version
        # pinned in package-lock.json — keeps the dep set tracking Playwright.

        if [ ! -f $SHARED/.env ]; then
            cat > $SHARED/.env << 'ENVEOF'
NODE_ENV=production
HEADLESS=true
HIBERNATE_DIR=/var/lib/browser-manager/hibernate
BROWSER_MANAGER_ADMIN_KEY=CHANGE_ME
# Public CDP reconnect endpoint + auth enforcement (agent-browser / Playwright).
CDP_PUBLIC_URL=wss://bm.todofor.ai
CDP_REQUIRE_AUTH=true
ENVEOF
            echo "Created default .env — edit $SHARED/.env"
        fi

        if [ ! -f $SHARED/noise.env ]; then
            echo "NOISE_LOCAL_PRIVATE_KEY=CHANGE_ME_32_BYTE_HEX" > $SHARED/noise.env
            chmod 600 $SHARED/noise.env
            echo "Created noise.env — set NOISE_LOCAL_PRIVATE_KEY in $SHARED/noise.env"
        fi

        mkdir -p /var/lib/browser-manager/hibernate

        echo "Done. Next: obtain a SAN TLS cert covering both names so the"
        echo "consolidated browser.todofor.ai/bm/ surface and the bm.todofor.ai"
        echo "compat alias share one lineage:"
        echo "  certbot --nginx -d browser.todofor.ai -d bm.todofor.ai"
EOF
    log "Server setup complete!"
}

case "${1:-deploy}" in
    deploy)   deploy ;;
    rollback) rollback ;;
    status)   status ;;
    logs)     logs ;;
    releases) releases ;;
    setup)    setup ;;
    *)        echo "Usage: $0 {deploy|rollback|status|logs|releases|setup}" ;;
esac
