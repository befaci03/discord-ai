{
	"name": "docker_cp",
	"description": "Copy one file between the sandbox and a container (docker cp). Exactly one side is an ABSOLUTE container path (that side decides the direction), the other is a path relative to the sandbox root. Needs [docker].enabled = true",
	"arguments": [
		{
			"type": "string",
			"name": "container",
			"description": "container name (see docker_list)",
			"disallow": []
		},
		{
			"type": "string",
			"name": "source",
			"description": "where to copy FROM: 'site/index.html' to inject a sandbox file, or '/usr/share/nginx/html/index.html' to pull a file out",
			"disallow": []
		},
		{
			"type": "string",
			"name": "destination",
			"description": "where to copy TO: '/usr/share/nginx/html/index.html' to inject a sandbox file, or 'index.html' to pull a file out",
			"disallow": []
		}
	]
}¤

set var res to docker.cp(args.container, args.source, args.destination)
if res.exitCode != 0 then
throw("docker cp failed: {1}".format([res.stderr + res.stdout]))
close
return("copied {1} -> {2}".format([args.source, args.destination]))
