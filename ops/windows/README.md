# Windows shortcuts

After the first successful Docker build, run this from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\windows\Install-Shortcuts.ps1
```

The installer creates **Start OpenShorts** and **Stop OpenShorts** on your Windows desktop.

Start launches Docker Desktop if necessary, starts the existing images without building or pulling, waits for the backend and dashboard, and opens http://localhost:5175 in your default browser. Keep using the same browser to retain your saved API keys. An error stays visible until you press Enter.

Stop stops only this project's services. It keeps containers, images, data, and Docker Desktop available for the next launch. Active processing is interrupted, so finish jobs before stopping.

The current Compose files (including your GPU override) still control the services. Docker Desktop must already be installed and configured. API services still require internet access; models may download on first use.

For the first build or after dependency updates, run `docker compose up --build -d` manually. If you move the repository or copy it to another PC, run the shortcut installer again from its new location. Each PC needs its own Docker setup and images.
