import struct, numpy as np
TYPES={2:'f4',3:'c8',4:'f8',5:'c16',8:'i1',0x10:'i2',0x20:'i4',0x48:'u1',0x50:'u2',0x60:'u4'}
def read_ibw(path):
    b=open(path,'rb').read()
    ver=struct.unpack_from('<h',b,0)[0]
    assert ver==5,(path,ver)
    wfm,form,note,deu=struct.unpack_from('<4i',b,4)
    dimeu=struct.unpack_from('<4i',b,20); dimlab=struct.unpack_from('<4i',b,36)
    sidx,o1,o2=struct.unpack_from('<3i',b,52)
    npnts=struct.unpack_from('<i',b,76)[0]
    typ=struct.unpack_from('<h',b,80)[0]
    name=b[92:124].split(b'\0')[0].decode('latin1')
    nd=struct.unpack_from('<4i',b,132)
    shape=[n for n in nd if n>0]
    off=384-4
    if typ==0:
        tail=sidx+form+note+deu+sum(dimeu)+sum(dimlab)+o1+o2
        data=b[384:len(b)-tail]; pos=len(b)-tail
    else:
        isz=np.dtype(TYPES[typ]).itemsize; n=int(np.prod(shape)) if shape else 0
        data=b[384:384+n*isz]; pos=384+n*isz
    fm=b[pos:pos+form].split(b'\0')[0].decode('latin1'); pos+=form
    nt=b[pos:pos+note].decode('latin1').replace('\r','\n'); pos+=note
    pos+=deu+sum(dimeu)
    labs=[]
    for k in range(4):
        sz=dimlab[k]
        if sz:
            blk=b[pos:pos+sz]; labs.append([blk[i:i+32].split(b'\0')[0].decode('latin1') for i in range(0,sz,32)])
            pos+=sz
        else: labs.append([])
    if typ==0:
        idx=struct.unpack_from('<%dI'%(sidx//4),b,pos) if sidx else None
        # strings: concatenated; sIndices = end offsets
        if idx and len(idx)>=npnts:
            ends=list(idx[:npnts]); s=0; out=[]
            for e in ends: out.append(data[s:e].decode('latin1')); s=e
        else:
            out=data.decode('latin1').split('\0')
        val=out
    else:
        val=np.frombuffer(data,dtype='<'+TYPES[typ&~1 if typ&1 else typ] if False else '<'+TYPES[typ]).reshape(shape[::-1]).T if len(shape)>1 else np.frombuffer(data,dtype='<'+TYPES[typ])
    return dict(name=name,shape=shape,type=typ,val=val,labels=labs,note=nt,formula=fm)
