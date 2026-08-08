# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting. Do not publish vulnerability details in an issue.

## Deployment boundary

File Manager can read, modify, and delete everything below `FILEMANAGER_ROOT`. It has no built-in authentication. Bind it to localhost, add authentication at a trusted reverse proxy before network exposure, and never configure the filesystem root or a directory containing secrets.
