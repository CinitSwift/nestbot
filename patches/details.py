import json
from typing import Optional

import aiohttp

from app.music.music import Music

NETEASE_API = 'http://host.docker.internal:3000'
NETEASE_DETAIL_URL = f'{NETEASE_API}/song/detail'
NETEASE_SOURCE_URL = f'{NETEASE_API}/song/url'
NETEASE_PROGRAM_DETAIL_API = f'{NETEASE_API}/dj/program/detail'


async def _fetch_playable_urls(song_ids: list) -> dict:
    urls = {}

    async with aiohttp.ClientSession() as session:
        for index in range(0, len(song_ids), 100):
            batch = song_ids[index:index + 100]
            ids = ','.join(map(str, batch))
            async with session.get(f'{NETEASE_SOURCE_URL}?id={ids}') as r:
                resp_json = json.loads(await r.text())
                for item in resp_json.get('data', []) or []:
                    urls[item.get('id')] = item.get('url')

    return urls


async def song_ids_to_instances(*song_ids: int) -> list[Music]:
    ids = ','.join(map(str, song_ids))

    async with aiohttp.ClientSession() as session:
        async with session.get(f'{NETEASE_DETAIL_URL}?ids={ids}') as r:
            resp_json = json.loads(await r.text())  # response is not application/json
            status = resp_json.get('code', 500)
            if status != 200:
                raise Exception(resp_json.get('error', f'fetch music details failed, code is {status}.'))
            songs = resp_json.get('songs', [])

    if not songs:
        return []

    playable = await _fetch_playable_urls([song.get('id') for song in songs])
    result = []

    for song in songs:
        source = playable.get(song.get('id'))
        if not source:
            continue
        result.append(Music(
            song.get('id'),
            song.get('name'),
            (song.get('ar') or song.get('artists') or [{}])[0].get('name', '未知歌手'),
            source,
            song.get('dt') or song.get('duration', 180000),
            (song.get('al') or song.get('album') or {}).get('name', '未知专辑'),
            f'{(song.get("al") or song.get("album") or {}).get("picUrl", "")}?param=130y130',
            'netease'
        ))

    return result


async def fetch_program_details_by_id(program_id) -> Optional[Music]:
    async with aiohttp.ClientSession() as session:
        async with session.get(f'{NETEASE_PROGRAM_DETAIL_API}?id={program_id}') as r:
            resp_json = json.loads(await r.text())
            status = resp_json.get('code', 500)
            if status != 200:
                raise Exception(resp_json.get('error', 'fetch program details failed, unknown reason.'))
            program = resp_json.get('program', {})
            song = program.get('mainSong', {})
            if song:
                playable = await _fetch_playable_urls([song.get('id')])
                source = playable.get(song.get('id'))
                if source:
                    return Music(
                        '',
                        song['name'],
                        (song.get('ar') or song.get('artists') or [{}])[0].get('name', '未知歌手'),
                        source,
                        song.get('dt') or song.get('duration', 180000),
                        (song.get('al') or song.get('album') or {}).get('name', '未知专辑'),
                        f'{program.get("coverUrl", "")}?param=130y130',
                        'netease_radio'
                    )
    return None
