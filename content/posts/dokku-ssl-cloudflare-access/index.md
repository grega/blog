---
title: Configuring SSL for a Dokku app behind Cloudflare Access
description:
date: 2026-04-10
tags: ["posts", "software", "devops", "dokku", "cloudflare", "ssl"]
---

I mostly use [Dokku](https://dokku.com/) to host my personal projects, and usually, securing an app is as simple as running the `dokku-letsencrypt` plugin.

However, things get slightly trickier when you want to put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) in front of an application. Cloudflare Access blocks all unauthorised traffic, naturally, and so Let's Encrypt's standard HTTP-01 challenge cannot reach your server to verify the domain, meaning Let's Encrypt renewals will fail.

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

### Wrapping up

Your Dokku app is now configured with a valid, long-lived Cloudflare Origin Certificate.

The connection between Cloudflare and your Dokku instance is now encrypted, so head over to the Cloudflare Zero Trust (aka Cloudflare One) dashboard and create an Access Application for `example-app.yourdomain.com`.
