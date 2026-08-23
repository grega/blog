---
title: Configuring SSL for a Dokku app behind Cloudflare Access
description:
date: 2026-04-10
tags: ["posts", "software", "devops", "dokku", "cloudflare", "ssl"]
---

I mostly use [Dokku](https://dokku.com/) to host my personal projects, and usually, securing an app is as simple as running the `dokku-letsencrypt` plugin.

However, things get slightly trickier when you want to put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) in front of an application. Cloudflare Access blocks all unauthorised traffic that reaches it, and so Let's Encrypt's standard HTTP-01 challenge cannot reach your server to verify the domain, meaning Let's Encrypt renewals will fail.

You *could* theoretically set up DNS-01 challenges, but if your app is already proxied through Cloudflare, there is a simple and robust solution: **Cloudflare Origin Certificates**.

By using an Origin Certificate, you maintain end-to-end SSL termination all the way to your Dokku instance, while letting Cloudflare’s edge handle the public-facing SSL and Zero Trust authentication.

Here's the step-by-step process to get it set up:

### 1. Proxy your domain through Cloudflare
First, ensure your app's DNS record (eg. `example-app.yourdomain.com`) is set up in Cloudflare and the proxy status is toggled on (the "orange cloud").

*Note: Make sure your SSL/TLS encryption mode in Cloudflare is set to **Full (Strict)**. This ensures Cloudflare verifies the Origin Certificate we are about to create.*

### 2. Generate an Origin Certificate
In your Cloudflare dashboard, navigate to **SSL/TLS -> Origin Server** and click **Create Certificate**.
* Keep the default RSA setting
* Ensure your specific subdomain (or a wildcard) is listed in the hostnames
* Click create, and Cloudflare will provide you with a **Certificate** and a **Private Key** (PEM format)

### 3. Save the certificate files
Copy the contents provided by Cloudflare and save them locally (ideally in a password manager), and then add them as two files in a directory on your Dokku server:
* `server.crt` (The Origin Certificate)
* `server.key` (The Private Key)

### 4. Create a tarball of the cert and key

Run the following command in the directory on your Dokku server where you saved your files:
```bash
tar cvf cert-key.tar server.crt server.key
```

### 5. Add the certificate to Dokku
Now, pipe that tarball directly into Dokku's `certs:add` command for your specific app (here our app is named `example-app`):

```bash
dokku certs:add example-app < cert-key.tar
```

### 6. Configure your application ports
Finally, you may need to map Dokku's external HTTP/HTTPS ports to your app's internal container port.

Let's say your app's Dockerfile specifies that the web process listens on port `5000`:

```dockerfile
ENV PORT=5000
EXPOSE 5000
```

You'll map port 80 and 443 to this port:

```bash
dokku ports:set example-app http:80:5000 https:443:5000
```

### 7. Lock the origin to Cloudflare

The connection from Cloudflare to Dokku is now encrypted, but the origin is still reachable around Cloudflare. Dokku routes by hostname, and the `Host` header is set by whoever is calling, so anyone who knows your server's IP can skip the edge, and your Access policy along with it:

```bash
curl -sk -H 'Host: example-app.yourdomain.com' https://your.server.ip/
```

If that returns your app, Access can be bypassed.

The fix is "Authenticated Origin Pulls"; Cloudflare presents a client certificate on every request to your origin, and nginx refuses anyone who can't produce it.

Cloudflare offers a shared certificate for this, but it's shared across all Cloudflare customers so passing that check proves a request came from Cloudflare, not that it came from your zone. Uploading your own certificate is the key here...

One point to keep in mind: Cloudflare wants a leaf (end-entity) certificate here. `openssl req -x509` on its own produces a `CA:TRUE` certificate and the upload is rejected with *"Missing leaf certificate"*. So generate a throwaway CA, then a client certificate signed by it:

```bash
# The CA, nginx trusts this
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout origin-pull-ca.key -out origin-pull-ca.crt \
  -subj "/CN=yourdomain.com origin pull CA"

# The leaf, this is what you upload to Cloudflare
openssl req -newkey rsa:2048 -nodes \
  -keyout origin-pull.key -out origin-pull.csr \
  -subj "/CN=yourdomain.com origin pull"

cat > leaf.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EOF

openssl x509 -req -in origin-pull.csr \
  -CA origin-pull-ca.crt -CAkey origin-pull-ca.key -CAcreateserial \
  -days 3650 -out origin-pull.crt -extfile leaf.ext

# The same check nginx will perform, should print "OK"
openssl verify -purpose sslclient -CAfile origin-pull-ca.crt origin-pull.crt
```

In the dashboard, go to "SSL/TLS -> Origin Server -> Authenticated Origin Pulls", upload `origin-pull.crt` as the certificate and `origin-pull.key` as the private key, then enable the zone toggle.

*Note: do this before the nginx step below. If nginx starts demanding a certificate Cloudflare isn't yet presenting, your app will return a 400*

Now tell nginx to require it. Copy up the CA certificate:

```bash
mkdir -p /etc/nginx/certs
install -m 644 origin-pull-ca.crt /etc/nginx/certs/origin-pull-ca.crt

mkdir -p /home/dokku/example-app/nginx.conf.d
cat > /home/dokku/example-app/nginx.conf.d/origin-pull.conf <<'EOF'
ssl_client_certificate /etc/nginx/certs/origin-pull-ca.crt;
ssl_verify_client on;
EOF
chown -R dokku:dokku /home/dokku/example-app/nginx.conf.d

dokku proxy:build-config example-app
```

Dokku includes `nginx.conf.d/*.conf` inside that app's server block, so the rule stays scoped to one app (the same directives in the `http` block would enforce mTLS for everything on the host).

To check that it worked, use `nginx -T` rather than `dokku nginx:show-config`: the latter shows only the `include` directive, not the file it pulls in.

```bash
nginx -T 2>/dev/null | grep -i ssl_verify_client   # ssl_verify_client on;
```

And the bypass from the top of this section should now fail at the handshake:

```bash
curl -sk -H 'Host: example-app.yourdomain.com' https://your.server.ip/
# 400 No required SSL certificate was sent
```

*Note: If you need to rollback: `rm /home/dokku/example-app/nginx.conf.d/origin-pull.conf && dokku proxy:build-config example-app`*

#### Alternative: Cloudflare Tunnel

Everything above keeps port 443 open to the world and then filters it. Alternatively, use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) which runs `cloudflared` on the Dokku host which connects out to Cloudflare instead.

### Wrapping up

Your Dokku app is now configured with a valid, long-lived Cloudflare Origin Certificate.

The connection between Cloudflare and your Dokku instance is now encrypted and only Cloudflare can open it, so head over to the Cloudflare Zero Trust (aka Cloudflare One) dashboard and create an Access Application for `example-app.yourdomain.com`.

One last thing worth mentioning; Access protects the edge, not your app itself. If a request ever does reach your origin another way, Access has no control over that, so it's worth having the app verify the signed `Cf-Access-Jwt-Assertion` header itself rather than blinding trusting any request (and blindly assuming that it originated from Cloudflare).
