{
	"name": "docker_create",
	"description": "Create and start a Docker container from an image. Port publishing is limited to the allowed port ranges in config (0 = publish nothing). Needs [docker].enabled = true",
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
		}
	]
}¤

set var cfg to { image: args.image }
if args.port > 0 then
cfg.ports = [args.port]
close
set var created to docker.create(args.name, cfg)
if created.exitCode != 0 then
throw("docker create failed: {1}".format([created.stderr + created.stdout]))
close
set var started to docker.start(args.name)
if started.exitCode != 0 then
throw("container created but start failed: {1}".format([started.stderr]))
close
return("container {1} created from {2} and started".format([args.name, args.image]))
