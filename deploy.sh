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

source "$(dirname "$0")/../scripts/deploy-lib.sh"

# Coexists with `browsing` on the same host (which owns browser.todofor.ai
# + ports 8085/8086). browser-manager runs on bm.todofor.ai + 8090/8092.
SERVER="${SERVER:-root@browser.todofor.ai}"
DEPLOY_PATH="/var/www/todoforai/apps/browser-manager"
REPO="git@github.com:todoforai/browser-manager.git"
BRANCH="prod"
KEEP_RELEASES=5

# Blue/green REST ports. Noise port = REST + 1.
PORT_A=8090
PORT_B=8092

deploy() {
    check_prod_status
    log "Starting browser-manager deployment to $SERVER..."

    RELEASE=$(date +%Y%m%d%H%M%S)

    ssh $SERVER 'bash -s' << EOF
        set -e

        mkdir -p $DEPLOY_PATH/releases $DEPLOY_PATH/shared

        echo "Creating release $RELEASE..."
        git clone --depth 1 --branch $BRANCH $REPO $DEPLOY_PATH/releases/$RELEASE

        echo "Installing dependencies..."
        cd $DEPLOY_PATH/releases/$RELEASE
        ~/.bun/bin/bun install

        echo "Installing Playwright Chromium..."
        ~/.bun/bin/bun node_modules/playwright/cli.js install chromium

        echo "Linking shared dir for ecosystem.config.cjs to read..."
        ln -sfn $DEPLOY_PATH/shared $DEPLOY_PATH/releases/$RELEASE/shared

        echo "Updating current symlink..."
        ln -sfn $DEPLOY_PATH/releases/$RELEASE $DEPLOY_PATH/current

        echo "Rolling deploy..."
        cd $DEPLOY_PATH/current

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

        echo "Starting new instance on port \$NEW_PORT..."
        DEPLOY_PORT=\$NEW_PORT pm2 start ecosystem.config.cjs --env production
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

        # Flip upstreams: mark all down, bring the new one up
        sed -i "s|server 127.0.0.1:$PORT_A[^;]*;|server 127.0.0.1:$PORT_A down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:$PORT_B[^;]*;|server 127.0.0.1:$PORT_B down;|g" \$NGINX_CONF
        sed -i "s|server 127.0.0.1:\$NEW_PORT down;|server 127.0.0.1:\$NEW_PORT max_fails=2 fail_timeout=5s;|" \$NGINX_CONF

        NEW_NOISE=\$((NEW_PORT + 1))
        NOISE_A=\$(($PORT_A + 1))
        NOISE_B=\$(($PORT_B + 1))
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
        DEPLOY_PORT=$ROLLBACK_PORT pm2 start ecosystem.config.cjs --env production
        pm2 save --force

        # Wait healthy before touching nginx
        NGINX_CONF=/etc/nginx/sites-available/bm.todofor.ai
        STREAM_CONF=/etc/nginx/streams-available/bm-noise-stream.conf
        for i in $(seq 1 15); do
            curl -sf http://127.0.0.1:$ROLLBACK_PORT/health >/dev/null 2>&1 && echo "✅ Rollback instance healthy" && break
            [ $i -eq 15 ] && { echo "❌ Rollback health check failed!"; pm2 logs browser-manager-$ROLLBACK_PORT --lines 40 --nostream; pm2 delete browser-manager-$ROLLBACK_PORT 2>/dev/null; exit 1; }
            sleep 2
        done

        ROLLBACK_NOISE=$((ROLLBACK_PORT + 1))
        NOISE_A=$((PORT_A + 1))
        NOISE_B=$((PORT_B + 1))
        sed -i "s|server 127.0.0.1:$PORT_A[^;]*;|server 127.0.0.1:$PORT_A down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:$PORT_B[^;]*;|server 127.0.0.1:$PORT_B down;|g" $NGINX_CONF
        sed -i "s|server 127.0.0.1:${ROLLBACK_PORT} down;|server 127.0.0.1:${ROLLBACK_PORT} max_fails=2 fail_timeout=5s;|" $NGINX_CONF

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

        if [ ! -f $SHARED/.env ]; then
            cat > $SHARED/.env << 'ENVEOF'
NODE_ENV=production
HEADLESS=true
HIBERNATE_DIR=/var/lib/browser-manager/hibernate
BROWSER_MANAGER_API_KEY=CHANGE_ME
ENVEOF
            echo "Created default .env — edit $SHARED/.env"
        fi

        if [ ! -f $SHARED/noise.env ]; then
            echo "NOISE_LOCAL_PRIVATE_KEY=CHANGE_ME_32_BYTE_HEX" > $SHARED/noise.env
            chmod 600 $SHARED/noise.env
            echo "Created noise.env — set NOISE_LOCAL_PRIVATE_KEY in $SHARED/noise.env"
        fi

        mkdir -p /var/lib/browser-manager/hibernate

        echo "Done. Next: obtain TLS cert:"
        echo "  certbot --nginx -d bm.todofor.ai"
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
