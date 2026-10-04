{
	"name": "docker_create",
	"description": "Create and start a Docker container from an image. The host port must be inside [docker].allowed_ports (the exact ranges are listed in your 'Your environment' block; 0 = publish nothing). Optional volume/volume_path mounts one of your sandbox volumes (sandbox/.docker-vols/<volume_id>) into the container at create time. Needs [docker].enabled = true",
	"arguments": [
		{
			"type": "string",
			"name": "name",
			"description": "container name: letters, digits, dash, dot or underscore",
			"disallow": []
		},
		{
			"type": "string",
			"name": "image",
			"description": "image reference, e.g. 'redis:7' or 'nginx:alpine'",
			"disallow": []
		},
		{
			"type": "number",
			"name": "port",
			"description": "host port to publish (0 = publish no port)",
			"disallow": []
		},
		{
			"type": "string",
			"name": "volume",
			"description": "optional: sandbox volume id to mount (stored in sandbox/.docker-vols/<id>); \"\" = mount nothing",
			"disallow": [],
			"optional": true
		},
		{
			"type": "string",
			"name": "volume_path",
			"description": "optional: container path for that volume (\"\" = /data)",
			"disallow": [],
			"optional": true
		}
	]
}¤

set var cfg to { image: args.image }
set var mnt to args.volume_path
if args.port > 0 then
cfg.ports = [args.port]
close
if mnt == "" then
mnt = "/data"
close
if args.volume != "" then
cfg.volumes = [{ volume: args.volume, container: mnt }]
close
set var created to docker.create(args.name, cfg)
if created.exitCode != 0 then
throw("docker create failed: {1}".format([created.stderr + created.stdout]))
close
set var started to docker.start(args.name)
if started.exitCode != 0 then
throw("container created but start failed: {1}".format([started.stderr]))
close
if args.volume != "" then
return("container {1} created from {2}, volume {3} mounted at {4}, started".format([args.name, args.image, args.volume, mnt]))
close
return("container {1} created from {2} and started".format([args.name, args.image]))
