# Deploying SolarScope on AWS EC2

One Ubuntu EC2 instance runs everything (FastAPI serves API and frontend).
The instance reads model weights from S3 through an **IAM instance role**; no access keys live on the server.

Why EC2 and not Lightsail: Lightsail instances cannot attach an IAM role, so S3 access would need stored keys.

## 0. Cost guard (do this first)
Billing -> Budgets -> Create budget -> "Zero spend" or a monthly cost budget of e.g. USD 10, with email alert.

## 1. S3 bucket for weights
S3 -> Create bucket -> name e.g. `solarscope-envi-hackathon` in region `ap-south-1` (Mumbai). Keep "Block all public access" ON.

## 2. IAM role for the instance
IAM -> Roles -> Create role -> Trusted entity: **AWS service, EC2** -> no managed policy -> name `solarscope-ec2-role`.
Then on the role: Add permissions -> Create inline policy -> JSON (replace the bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::solarscope-envi-hackathon" },
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::solarscope-envi-hackathon/*" }
  ]
}
```

## 3. Launch the instance
EC2 (region ap-south-1) -> Launch instance:
- Name `solarscope`, AMI **Ubuntu Server 24.04 LTS**, type **t3.small** (2 GB RAM)
- Key pair: create one, save the `.pem` **outside the repo** (e.g. `$HOME\.ssh\solarscope.pem`)
- Network: allow SSH (source: My IP), allow HTTP, allow HTTPS
- Storage: 16 GB gp3
- Advanced details -> **IAM instance profile: `solarscope-ec2-role`**

Optional: Elastic IP (EC2 -> Elastic IPs -> Allocate -> Associate) so the public IP survives stop/start.

## 4. Install
Connect with **EC2 Instance Connect** (instance page -> Connect -> Connect, opens a browser terminal) or from PowerShell:

```powershell
ssh -i $HOME\.ssh\solarscope.pem ubuntu@<public-ip>
```

Then on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/Pai05/solarscope/main/infra/setup.sh | sudo bash
```

Expected last lines: `{"status":"ok"}` and `Done.`

## 5. Verify
- Browser: `http://<public-ip>/health` -> `{"status":"ok"}`; `http://<public-ip>/` -> SolarScope page
- Role works: `aws sts get-caller-identity` on the server shows `assumed-role/solarscope-ec2-role/...`
- Survives reboot: `sudo reboot`, wait 1 min, reload `/health`

## Update after a push
```bash
curl -fsSL https://raw.githubusercontent.com/Pai05/solarscope/main/infra/setup.sh | sudo bash
```

## Logs
```bash
sudo journalctl -u solarscope -f
```

## Model weights (after training)
1. S3 console -> bucket `solarscope-envi-hackathon` -> Create folder `models` -> upload `solarscope.onnx` and `solarscope.json`.
2. On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/Pai05/solarscope/main/infra/setup.sh | sudo MODEL_S3_PREFIX=s3://solarscope-envi-hackathon/models bash
```

3. `http://<public-ip>/health` -> `{"status":"ok","model_loaded":true}`. The prefix is remembered in `/etc/solarscope.conf`,
   so later updates only need the plain `curl ... | sudo bash`.

## HTTPS and AR wall measurement
`setup.sh` also installs **Caddy**, which serves the app over HTTPS at `https://<a-b-c-d>.sslip.io/`
(your public IP with dashes, e.g. `https://13-233-10-20.sslip.io/`) and gets a Let's Encrypt certificate
automatically. Browsers only allow the camera / WebXR AR on HTTPS, so open this address on the phone.
Plain `http://<public-ip>/` keeps working. Needs inbound ports 80 and 443 open in the security group.

If the public IP changes (stop/start without an Elastic IP), re-run `setup.sh` to regenerate the address.

AR test: Android phone with ARCore, **Chrome**, open the https address -> step 2 "Measure a wall with AR"
-> tap where the wall meets the ground at both corners -> Save length (x3) -> Use median ->
drag the same wall on the image -> Apply.
