{
	"name": "docker_manage",
	"description": "Start, stop, restart, remove or recreate a container, or mount one of your sandbox volumes into an existing one (action=mount: the volume id lives in sandbox/.docker-vols/<volume_id>; the container is recreated and started with the mount). Needs [docker].enabled = true",
	"arguments": [
		{
			"type": "string",
			"name": "container",
			"description": "container name (see docker_list)",
			"disallow": []
		},
		{
			"type": "string",
			"name": "action",
			"description": "one of: start, stop, restart, remove, recreate, mount",
			"disallow": []
		},
		{
			"type": "string",
			"name": "volume",
			"description": "action=mount only: sandbox volume id (stored in sandbox/.docker-vols/<id>); pass \"\" for every other action",
			"disallow": [],
			"optional": true
		},
		{
			"type": "string",
			"name": "volume_path",
			"description": "action=mount only: container path to mount at, e.g. /var/lib/data (\"\" = /data); pass \"\" for every other action",
			"disallow": [],
			"optional": true
		}
	]
}¤

set var res to null
if args.action == "start" then
res = docker.start(args.container)
if res.exitCode != 0 then
throw("start failed: {1}".format([res.stderr]))
close
return("started {1}".format([args.container]))
close
if args.action == "stop" then
res = docker.stop(args.container)
if res.exitCode != 0 then
throw("stop failed: {1}".format([res.stderr]))
close
return("stopped {1}".format([args.container]))
close
if args.action == "restart" then
res = docker.restart(args.container)
if res.exitCode != 0 then
throw("restart failed: {1}".format([res.stderr]))
close
return("restarted {1}".format([args.container]))
close
if args.action == "remove" then
res = docker.remove(args.container)
if res.exitCode != 0 then
throw("remove failed: {1}".format([res.stderr]))
close
return("removed {1}".format([args.container]))
close
if args.action == "recreate" then
res = docker.recreate(args.container)
if res.exitCode != 0 then
throw("recreate failed: {1}".format([res.stderr]))
close
return("recreated {1}".format([args.container]))
close
if args.action == "mount" then
if args.volume == "" then
throw("docker_manage: action 'mount' needs a volume id (it lives in sandbox/.docker-vols/<volume_id>)")
close
set var mnt to args.volume_path
if mnt == "" then
mnt = "/data"
close
res = docker.attach(args.container, args.volume, mnt)
if res.exitCode != 0 then
throw("mount failed: {1}".format([res.stderr]))
close
return("volume {1} mounted at {2} on {3}: container recreated and started".format([args.volume, mnt, args.container]))
close
throw("docker_manage: action must be one of start, stop, restart, remove, recreate, mount")
